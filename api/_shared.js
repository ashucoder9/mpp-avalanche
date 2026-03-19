// Shared config for all API routes
export const STREAM_CHANNEL = "0x6e2DD66C1bfb66a2b579D291CdF6EA559E93619b"; // Fuji
export const USDC_ADDRESS = "0x5425890298aed601595a70AB815c96711a31Bc65"; // Fuji USDC
export const CHAIN_ID = 43113;
export const RPC_URL = "https://api.avax-test.network/ext/bc/C/rpc";
export const PAYEE_ADDRESS = process.env.PAYEE_ADDRESS || "0x3d7ABa125BA3ab7716373A5635DDb62fFdFED787";
export const DECIMALS = 6;
export const PRICE_PER_REQUEST = "100000"; // 0.10 USDC

export const streamChannelAbi = [
  {
    type: "function", name: "getChannel",
    inputs: [{ name: "channelId", type: "bytes32" }],
    outputs: [{
      name: "", type: "tuple",
      components: [
        { name: "finalized", type: "bool" },
        { name: "closeRequestedAt", type: "uint64" },
        { name: "payer", type: "address" },
        { name: "payee", type: "address" },
        { name: "token", type: "address" },
        { name: "authorizedSigner", type: "address" },
        { name: "deposit", type: "uint128" },
        { name: "settled", type: "uint128" },
      ],
    }],
    stateMutability: "view",
  },
];

// In-memory voucher store (resets on cold start — fine for demo)
// For production, use a KV store like Vercel KV or Redis
export const pendingVouchers = new Map();

export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}
