/**
 * MPP Agent (Payer Side)
 *
 * Demonstrates:
 * 1. Opening a payment channel with an ERC-20 deposit
 * 2. Signing cumulative vouchers off-chain (zero gas)
 * 3. Sending vouchers to a service via HTTP (MPP 402 flow)
 *
 * Usage: npx tsx src/agent.ts
 */

import "dotenv/config";
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  avalancheFuji,
  STREAM_CHANNEL_ADDRESS,
  TEST_TOKEN_ADDRESS,
  streamChannelAbi,
  erc20Abi,
} from "./config.js";

const PRIVATE_KEY = process.env.PRIVATE_KEY as Hex;
if (!PRIVATE_KEY) throw new Error("Set PRIVATE_KEY in .env");

const SERVICE_URL = process.env.SERVICE_URL || "http://localhost:3402";

const account = privateKeyToAccount(
  PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`
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

// ─── EIP-712 domain (must match contract's _domainNameAndVersion) ───

const DOMAIN = {
  name: "Tempo Stream Channel",
  version: "1",
  chainId: 43113,
  verifyingContract: STREAM_CHANNEL_ADDRESS,
} as const;

const VOUCHER_TYPES = {
  Voucher: [
    { name: "channelId", type: "bytes32" },
    { name: "cumulativeAmount", type: "uint128" },
  ],
} as const;

// ─── Voucher signing (off-chain, zero gas) ─────────────────────

async function signVoucher(
  channelId: Hex,
  cumulativeAmount: bigint
): Promise<Hex> {
  // Sign EIP-712 typed data directly — no personal_sign prefix
  const signature = await walletClient.signTypedData({
    domain: DOMAIN,
    types: VOUCHER_TYPES,
    primaryType: "Voucher",
    message: {
      channelId,
      cumulativeAmount,
    },
  });

  return signature;
}

// ─── Main flow ─────────────────────────────────────────────────

async function main() {
  const payeeAddress = process.env.PAYEE_ADDRESS as Hex;
  if (!payeeAddress)
    throw new Error("Set PAYEE_ADDRESS in .env (the service's address)");

  console.log("=== MPP Agent (Payer) ===");
  console.log(`Payer:   ${account.address}`);
  console.log(`Payee:   ${payeeAddress}`);
  console.log(`Token:   ${TEST_TOKEN_ADDRESS} (USDC on Fuji)`);
  console.log(`Channel: ${STREAM_CHANNEL_ADDRESS}`);
  console.log();

  // USDC has 6 decimals
  const DECIMALS = 6;
  const depositAmount = parseUnits("1", DECIMALS); // 1 USDC

  // Step 1: Check USDC balance
  const balance = await publicClient.readContract({
    address: TEST_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [account.address],
  });
  console.log(`[1] USDC balance: ${formatUnits(balance, DECIMALS)}`);
  if (balance < depositAmount) {
    throw new Error(
      `Need at least ${formatUnits(depositAmount, DECIMALS)} USDC. Get test USDC from the Aave Fuji faucet.`
    );
  }

  // Step 2: Approve StreamChannel to spend USDC
  console.log("[2] Approving StreamChannel to spend USDC...");
  const approveHash = await walletClient.writeContract({
    address: TEST_TOKEN_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [STREAM_CHANNEL_ADDRESS, depositAmount],
  });
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
  console.log(`    Approve tx: ${approveHash}`);

  // Step 3: Open channel
  const salt =
    `0x${Buffer.from(Date.now().toString()).toString("hex").padEnd(64, "0")}` as Hex;

  console.log(`[3] Opening channel with ${formatUnits(depositAmount, DECIMALS)} USDC deposit...`);
  const openHash = await walletClient.writeContract({
    address: STREAM_CHANNEL_ADDRESS,
    abi: streamChannelAbi,
    functionName: "open",
    args: [
      payeeAddress,
      TEST_TOKEN_ADDRESS,
      depositAmount,
      salt,
      "0x0000000000000000000000000000000000000000", // no delegated signer
    ],
  });
  const openReceipt = await publicClient.waitForTransactionReceipt({
    hash: openHash,
  });
  console.log(`    Open tx: ${openHash}`);

  // Compute the channel ID
  const channelId = await publicClient.readContract({
    address: STREAM_CHANNEL_ADDRESS,
    abi: streamChannelAbi,
    functionName: "computeChannelId",
    args: [
      account.address,
      payeeAddress,
      TEST_TOKEN_ADDRESS,
      salt,
      "0x0000000000000000000000000000000000000000",
    ],
  });
  console.log(`    Channel ID: ${channelId}`);
  console.log();

  // Step 4: Simulate streaming — sign vouchers and send to service
  const PRICE_PER_REQUEST = parseUnits("0.1", DECIMALS); // 0.10 USDC per API call
  const NUM_REQUESTS = 5;

  console.log(
    `[4] Making ${NUM_REQUESTS} API requests, paying ${formatUnits(PRICE_PER_REQUEST, DECIMALS)} USDC each...`
  );
  console.log();

  for (let i = 1; i <= NUM_REQUESTS; i++) {
    const cumulativeAmount = PRICE_PER_REQUEST * BigInt(i);

    // Sign voucher off-chain (FREE — no gas!)
    const voucher = await signVoucher(channelId, cumulativeAmount);

    console.log(
      `  Request #${i}: cumulative=${formatUnits(cumulativeAmount, DECIMALS)} USDC`
    );

    // Send request to service with voucher (MPP 402 flow)
    try {
      const response = await fetch(`${SERVICE_URL}/api/data`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-MPP-Channel-Id": channelId,
          "X-MPP-Cumulative-Amount": cumulativeAmount.toString(),
          "X-MPP-Voucher": voucher,
        },
        body: JSON.stringify({ query: `request-${i}` }),
      });

      if (response.ok) {
        const data = await response.json();
        console.log(`    ✓ Response: ${JSON.stringify(data)}`);
      } else {
        console.log(`    ✗ HTTP ${response.status}: ${await response.text()}`);
      }
    } catch (e: any) {
      console.log(
        `    ✗ Service unreachable (${e.message}) — voucher signed anyway`
      );
    }
  }

  console.log();
  console.log("=== Done ===");
  console.log(
    `Total spent: ${formatUnits(PRICE_PER_REQUEST * BigInt(NUM_REQUESTS), DECIMALS)} USDC (all off-chain vouchers)`
  );
  console.log(
    "The service can now settle these vouchers on-chain whenever it wants."
  );

  // Read channel state
  const ch = await publicClient.readContract({
    address: STREAM_CHANNEL_ADDRESS,
    abi: streamChannelAbi,
    functionName: "getChannel",
    args: [channelId],
  });
  console.log();
  console.log("Channel state on-chain:");
  console.log(`  deposit:  ${formatUnits(ch.deposit, DECIMALS)} USDC`);
  console.log(`  settled:  ${formatUnits(ch.settled, DECIMALS)} USDC`);
  console.log(`  finalized: ${ch.finalized}`);
}

main().catch(console.error);
