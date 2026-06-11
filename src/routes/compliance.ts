/**
 * POST /compliance/screen
 *
 * Screens a party name, entity, or trade route against:
 *   - OFAC SDN list (US Treasury, public domain)
 *   - OpenSanctions database (optional, requires API key)
 *
 * Protected by x402 micropayment — requires $COMPLIANCE_SCREEN_PRICE_USDC per call.
 *
 * Request body:
 *   { query: string }  — party name, company, or trade description
 *
 * Response:
 *   { query, isSanctioned, ofac, openSanctions, summary }
 */

import { Router }                          from "express";
import { z }                               from "zod";
import { requirePayment }                  from "../middleware/x402";
import { screenAgainstOFAC }              from "../lib/ofac";
import { screenAgainstOpenSanctions }     from "../lib/opensanctions";

const router = Router();

const priceUSDC = process.env.COMPLIANCE_SCREEN_PRICE_USDC ?? "0.05";

const BodySchema = z.object({
  query: z.string().min(2),
});

router.post(
  "/screen",
  requirePayment({ amountUSDC: priceUSDC }),
  async (req, res) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "query field required" });
      return;
    }

    const { query } = parsed.data;

    try {
      const [ofac, openSanctions] = await Promise.all([
        screenAgainstOFAC(query),
        screenAgainstOpenSanctions(query),
      ]);

      const isSanctioned = ofac.isSanctioned || openSanctions.isSanctioned;

      const summary = isSanctioned
        ? `ALERT: "${query}" has matches on one or more sanctions lists. Do not proceed without legal review.`
        : `No sanctions matches found for "${query}" across OFAC SDN and OpenSanctions databases.`;

      res.json({
        query,
        isSanctioned,
        summary,
        ofac,
        openSanctions,
        paidBy: (req as typeof req & { x402Payer?: string }).x402Payer,
        screenedAt: new Date().toISOString(),
      });
    } catch (err) {
      console.error("[compliance/screen]", err);
      res.status(500).json({ error: "Compliance screening failed" });
    }
  }
);

export default router;
