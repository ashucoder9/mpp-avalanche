import { STREAM_CHANNEL, USDC_ADDRESS, CHAIN_ID, PAYEE_ADDRESS, PRICE_PER_REQUEST, cors } from "./_shared.js";

export default function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  res.json({
    version: "draft-tempo-stream-00",
    payee: PAYEE_ADDRESS,
    channel_contract: STREAM_CHANNEL,
    chain_id: CHAIN_ID,
    price_per_request: PRICE_PER_REQUEST,
    accepted_tokens: [USDC_ADDRESS],
  });
}
