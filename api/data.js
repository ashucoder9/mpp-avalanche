import { createPublicClient, http, formatUnits } from "viem";
import { avalancheFuji } from "viem/chains";
import {
  STREAM_CHANNEL, PAYEE_ADDRESS, DECIMALS,
  streamChannelAbi, pendingVouchers, cors,
} from "./_shared.js";

const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(),
});

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const channelId = req.headers["x-mpp-channel-id"];
  const cumulativeStr = req.headers["x-mpp-cumulative-amount"];
  const voucher = req.headers["x-mpp-voucher"];

  // No payment → 402
  if (!channelId || !cumulativeStr || !voucher) {
    return res.status(402).json({
      error: "Payment Required",
      mpp_info: "GET /.well-known/mpp for payment details",
      price_per_request: "0.10 USDC",
    });
  }

  const cumulativeAmount = BigInt(cumulativeStr);

  // Verify channel on-chain
  try {
    const channel = await publicClient.readContract({
      address: STREAM_CHANNEL,
      abi: streamChannelAbi,
      functionName: "getChannel",
      args: [channelId],
    });

    if (channel.payee.toLowerCase() !== PAYEE_ADDRESS.toLowerCase()) {
      return res.status(400).json({ error: "Channel payee mismatch" });
    }
    if (channel.finalized) {
      return res.status(400).json({ error: "Channel is finalized" });
    }
    if (cumulativeAmount > channel.deposit) {
      return res.status(400).json({ error: "Cumulative amount exceeds deposit" });
    }
  } catch (e) {
    return res.status(400).json({ error: `Channel check failed: ${e.shortMessage || e.message}` });
  }

  // Track voucher
  const existing = pendingVouchers.get(channelId);
  if (!existing || cumulativeAmount > existing.cumulativeAmount) {
    pendingVouchers.set(channelId, { channelId, cumulativeAmount, signature: voucher });
  }

  // Return real data based on query
  const query = (req.body?.query || "price").toLowerCase();
  let data;

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
    data = { message: `Query "${req.body?.query}" processed`, timestamp: new Date().toISOString() };
  }

  res.json({
    data,
    payment: {
      cumulative_paid: `${formatUnits(cumulativeAmount, DECIMALS)} USDC`,
      channel: channelId,
    },
  });
}
