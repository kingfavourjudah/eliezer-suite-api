/**
 * POST /shipping/rates
 *
 * Returns shipping rate quotes for a trade corridor.
 * Protected by x402 micropayment — requires $SHIPPING_RATE_PRICE_USDC USDC per call.
 *
 * Request body:
 *   { query: string }  — natural language OR structured JSON string
 *
 * Response:
 *   { origin, destination, weightKg, cbm, quotes[], exchangeRates }
 */

import { Router }           from "express";
import { z }                from "zod";
import { requirePayment }   from "../middleware/x402";
import { getShippingRates } from "../lib/shipping-rates";
import { getExchangeRates, convertUSD } from "../lib/exchange-rates";

const router = Router();

const priceUSDC = process.env.SHIPPING_RATE_PRICE_USDC ?? "0.10";

const BodySchema = z.object({
  query: z.string().min(5),
});

// ── Parse natural language query into structured fields ───────────────────
// Extracts origin, destination, weight, CBM from free text.
// Good enough for the MVP; replace with an NLP call if needed.

function parseQuery(query: string) {
  const lower = query.toLowerCase();

  // Weight: "50 kg", "50kg", "100 kilograms"
  const weightMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:kg|kgs|kilogram)/);
  const weightKg    = weightMatch ? parseFloat(weightMatch[1]) : 50;

  // CBM: "2 cbm", "2.5 cbm"
  const cbmMatch = lower.match(/(\d+(?:\.\d+)?)\s*(?:cbm|cubic)/);
  const cbm      = cbmMatch ? parseFloat(cbmMatch[1]) : undefined;

  // Mode
  let mode: "sea_fcl" | "sea_lcl" | "air" | "express" | undefined;
  if (lower.includes("fcl") || lower.includes("full container")) mode = "sea_fcl";
  else if (lower.includes("lcl") || lower.includes("sea") || lower.includes("ocean")) mode = "sea_lcl";
  else if (lower.includes("express") || lower.includes("dhl") || lower.includes("fedex")) mode = "express";
  else if (lower.includes("air")) mode = "air";

  // Origin / destination (order matters — try known city names)
  const CITIES = [
    "guangzhou", "shenzhen", "shanghai", "beijing", "yiwu", "hong kong",
    "lagos", "abuja", "london", "new york", "los angeles", "dubai",
    "nairobi", "accra", "toronto", "vancouver",
  ];
  const found = CITIES.filter((c) => lower.includes(c));
  const origin      = found[0] ?? "guangzhou";
  const destination = found[1] ?? "lagos";

  return { origin, destination, weightKg, cbm, mode };
}

router.post(
  "/rates",
  requirePayment({ amountUSDC: priceUSDC }),
  async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "query field required (min 5 chars)" });
      return;
    }

    try {
      const structured = parseQuery(parsed.data.query);
      const [result, rates] = await Promise.all([
        getShippingRates(structured),
        getExchangeRates(),
      ]);

      // Attach multi-currency conversion to each quote
      const quotesWithFX = result.quotes.map((q) => ({
        ...q,
        priceConverted: convertUSD(q.priceUSD, rates),
      }));

      res.json({
        ...result,
        quotes:        quotesWithFX,
        exchangeRates: { CNY: rates.CNY, NGN: rates.NGN },
        paidBy:        (req as typeof req & { x402Payer?: string }).x402Payer,
      });
    } catch (err) {
      console.error("[shipping/rates]", err);
      res.status(500).json({ error: "Rate lookup failed" });
    }
  }
);

export default router;
