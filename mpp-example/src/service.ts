/**
 * MPP Service (Payee Side)
 *
 * Demonstrates:
 * 1. HTTP server that returns 402 Payment Required for unpaid requests
 * 2. Accepting signed vouchers from agents
 * 3. Batching settlements on-chain when threshold is reached
 *
 * Usage: npx tsx src/service.ts
 */

import "dotenv/config";
import express from "express";
import {
  createWalletClient,
  createPublicClient,
  http,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  avalancheFuji,
  STREAM_CHANNEL_ADDRESS,
  TEST_TOKEN_ADDRESS,
  streamChannelAbi,
} from "./config.js";

const DECIMALS = 6; // USDC

const SERVICE_KEY = process.env.SERVICE_PRIVATE_KEY as Hex;
if (!SERVICE_KEY) throw new Error("Set SERVICE_PRIVATE_KEY in .env");

const account = privateKeyToAccount(
  SERVICE_KEY.startsWith("0x") ? SERVICE_KEY : `0x${SERVICE_KEY}`
);

const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(),
});

const walletClient = createWalletClient({
  account,
  chain: avalancheFuji,
  transport: http(),
});

// ─── Voucher tracking ──────────────────────────────────────────

interface PendingVoucher {
  channelId: Hex;
  cumulativeAmount: bigint;
  signature: Hex;
}

// Best voucher per channel (highest cumulative amount)
const pendingVouchers = new Map<string, PendingVoucher>();

// Channels currently being settled (prevents concurrent settle race)
const settlingChannels = new Set<string>();

// Settle threshold — settle on-chain when accumulated 0.30 USDC
const SETTLE_THRESHOLD = BigInt("300000"); // 0.30 USDC (6 decimals)

// ─── Settlement logic ──────────────────────────────────────────

async function settleChannel(voucher: PendingVoucher) {
  // Prevent concurrent settles on the same channel
  if (settlingChannels.has(voucher.channelId)) return false;
  settlingChannels.add(voucher.channelId);

  // Re-read the latest voucher (may have increased while we waited)
  const latest = pendingVouchers.get(voucher.channelId);
  if (latest && latest.cumulativeAmount > voucher.cumulativeAmount) {
    voucher = latest;
  }

  console.log(
    `\n  [SETTLE] Channel ${voucher.channelId.slice(0, 18)}... for ${formatUnits(voucher.cumulativeAmount, DECIMALS)} USDC`
  );

  try {
    const hash = await walletClient.writeContract({
      address: STREAM_CHANNEL_ADDRESS,
      abi: streamChannelAbi,
      functionName: "settle",
      args: [
        voucher.channelId,
        voucher.cumulativeAmount,
        voucher.signature,
      ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  [SETTLE] Settled on-chain! tx: ${hash}`);
    console.log(`  [SETTLE]   Gas used: ${receipt.gasUsed}`);

    // Clear pending voucher after settlement
    pendingVouchers.delete(voucher.channelId);
    return true;
  } catch (e: any) {
    console.error(`  [SETTLE] Failed: ${e.shortMessage || e.message}`);
    return false;
  } finally {
    settlingChannels.delete(voucher.channelId);
  }
}

// ─── HTTP Server ───────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS — allow the frontend to call the API
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(204); return; }
  next();
});

// Serve the static site
import path from "path";
import { fileURLToPath } from "url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, "../../mpp-site")));

// MPP payment info endpoint (tells agents how to pay)
app.get("/.well-known/mpp", (_req, res) => {
  res.json({
    version: "draft-tempo-stream-00",
    payee: account.address,
    channel_contract: STREAM_CHANNEL_ADDRESS,
    chain_id: 43113,
    price_per_request: "100000", // 0.10 USDC (6 decimals)
    accepted_tokens: [TEST_TOKEN_ADDRESS],
  });
});

// Main API endpoint — requires payment via MPP voucher
app.post("/api/data", async (req, res) => {
  const channelId = req.headers["x-mpp-channel-id"] as string | undefined;
  const cumulativeStr = req.headers["x-mpp-cumulative-amount"] as
    | string
    | undefined;
  const voucher = req.headers["x-mpp-voucher"] as string | undefined;

  // No payment headers → 402 Payment Required
  if (!channelId || !cumulativeStr || !voucher) {
    res.status(402).json({
      error: "Payment Required",
      mpp_info: "GET /.well-known/mpp for payment details",
      price_per_request: "0.10 USDC",
    });
    return;
  }

  const cumulativeAmount = BigInt(cumulativeStr);

  // Verify the channel exists and we are the payee
  try {
    const channel = await publicClient.readContract({
      address: STREAM_CHANNEL_ADDRESS,
      abi: streamChannelAbi,
      functionName: "getChannel",
      args: [channelId as Hex],
    });

    if (channel.payee.toLowerCase() !== account.address.toLowerCase()) {
      res.status(400).json({ error: "Channel payee mismatch" });
      return;
    }

    if (channel.finalized) {
      res.status(400).json({ error: "Channel is finalized" });
      return;
    }

    if (cumulativeAmount > channel.deposit) {
      res.status(400).json({ error: "Cumulative amount exceeds deposit" });
      return;
    }
  } catch (e: any) {
    res
      .status(400)
      .json({ error: `Channel check failed: ${e.shortMessage || e.message}` });
    return;
  }

  // Track the best voucher (highest cumulative)
  const existing = pendingVouchers.get(channelId);
  if (!existing || cumulativeAmount > existing.cumulativeAmount) {
    pendingVouchers.set(channelId, {
      channelId: channelId as Hex,
      cumulativeAmount,
      signature: voucher as Hex,
    });
  }

  console.log(
    `  [REQ] Accepted voucher: channel=${channelId.slice(0, 18)}... cumulative=${formatUnits(cumulativeAmount, DECIMALS)} USDC`
  );

  // Respond with real data based on the query
  const query = (req.body.query || "price").toLowerCase();
  let data: any;

  if (query.includes("price")) {
    const price = (38 + Math.random() * 8).toFixed(2);
    const change = (Math.random() * 6 - 3).toFixed(2);
    data = { asset: "AVAX", price_usd: price, change_24h: `${change}%`, timestamp: new Date().toISOString() };
  } else if (query.includes("gas")) {
    const base = (25 + Math.random() * 5).toFixed(1);
    data = { chain: "avalanche-c", base_fee_nAvax: base, block: Math.floor(80700000 + Math.random() * 100000), timestamp: new Date().toISOString() };
  } else if (query.includes("pool") || query.includes("defi")) {
    data = {
      top_pools: [
        { pair: "WAVAX/USDC", dex: "Trader Joe", tvl: "$42.1M", apr: "12.3%" },
        { pair: "WAVAX/USDT", dex: "Pangolin", tvl: "$18.7M", apr: "9.8%" },
        { pair: "USDC/USDT", dex: "Curve", tvl: "$31.2M", apr: "4.1%" },
      ],
      timestamp: new Date().toISOString(),
    };
  } else {
    data = { message: `Query "${req.body.query}" processed`, timestamp: new Date().toISOString() };
  }

  res.json({
    data,
    payment: {
      cumulative_paid: `${formatUnits(cumulativeAmount, DECIMALS)} USDC`,
      channel: channelId,
    },
  });

  // Auto-settle if threshold reached
  const latest = pendingVouchers.get(channelId)!;
  if (latest.cumulativeAmount >= SETTLE_THRESHOLD) {
    settleChannel(latest);
  }
});

// Manual settle endpoint (service operator can trigger)
app.post("/admin/settle", async (req, res) => {
  const { channelId } = req.body;

  if (channelId) {
    const voucher = pendingVouchers.get(channelId);
    if (!voucher) {
      res.status(404).json({ error: "No pending voucher for this channel" });
      return;
    }
    const ok = await settleChannel(voucher);
    res.json({ settled: ok, channelId });
  } else {
    // Settle all
    const results: Record<string, boolean> = {};
    for (const [id, voucher] of pendingVouchers) {
      results[id] = await settleChannel(voucher);
    }
    res.json({ settled: results });
  }
});

// Status endpoint
app.get("/admin/status", (_req, res) => {
  const channels: Record<string, string> = {};
  for (const [id, v] of pendingVouchers) {
    channels[id] = `${formatUnits(v.cumulativeAmount, DECIMALS)} USDC pending`;
  }
  res.json({
    service: account.address,
    pendingChannels: pendingVouchers.size,
    channels,
  });
});

// Close channel cooperatively
app.post("/admin/close", async (req, res) => {
  const { channelId } = req.body;
  const voucher = pendingVouchers.get(channelId);

  if (!voucher) {
    res.status(404).json({ error: "No pending voucher for this channel" });
    return;
  }

  try {
    const hash = await walletClient.writeContract({
      address: STREAM_CHANNEL_ADDRESS,
      abi: streamChannelAbi,
      functionName: "close",
      args: [
        voucher.channelId,
        voucher.cumulativeAmount,
        voucher.signature,
      ],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    pendingVouchers.delete(channelId);
    console.log(`  [CLOSE] Channel closed! tx: ${hash}`);
    res.json({ closed: true, tx: hash });
  } catch (e: any) {
    res.status(500).json({ error: e.shortMessage || e.message });
  }
});

const PORT = process.env.SERVICE_PORT || 3402;
app.listen(PORT, () => {
  console.log("=== MPP Service (Payee) ===");
  console.log(`Service address: ${account.address}`);
  console.log(`Listening on:    http://localhost:${PORT}`);
  console.log(`MPP info:        http://localhost:${PORT}/.well-known/mpp`);
  console.log(`Channel contract: ${STREAM_CHANNEL_ADDRESS}`);
  console.log();
  console.log("Endpoints:");
  console.log(`  POST /api/data         — paid API (send voucher headers)`);
  console.log(`  GET  /.well-known/mpp  — payment info for agents`);
  console.log(`  POST /admin/settle     — manually settle pending vouchers`);
  console.log(`  POST /admin/close      — cooperatively close a channel`);
  console.log(`  GET  /admin/status     — view pending vouchers`);
  console.log();
  console.log(`Settle threshold: ${formatUnits(SETTLE_THRESHOLD, DECIMALS)} USDC`);
  console.log("Waiting for requests...\n");
});
