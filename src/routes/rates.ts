/**
 * GET /rates/exchange
 *
 * Public endpoint — no x402 payment required.
 * Returns live USD → CNY / NGN exchange rates for display in the frontend.
 *
 * Cached for 1 hour. Falls back to reference rates when API key is unset.
 */

import { Router }                    from "express";
import { getExchangeRates }          from "../lib/exchange-rates";

const router = Router();

router.get("/exchange", async (_req, res) => {
  try {
    const rates = await getExchangeRates();
    res.json({
      base:      "USD",
      rates:     { CNY: rates.CNY, NGN: rates.NGN },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[rates/exchange]", err);
    res.status(500).json({ error: "Exchange rate fetch failed" });
  }
});

export default router;
