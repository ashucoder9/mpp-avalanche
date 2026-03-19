import { formatUnits } from "viem";
import { PAYEE_ADDRESS, DECIMALS, pendingVouchers, cors } from "./_shared.js";

export default function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const channels = {};
  for (const [id, v] of pendingVouchers) {
    channels[id] = `${formatUnits(v.cumulativeAmount, DECIMALS)} USDC pending`;
  }

  res.json({
    service: PAYEE_ADDRESS,
    pendingChannels: pendingVouchers.size,
    channels,
  });
}
