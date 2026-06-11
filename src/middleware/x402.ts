/**
 * x402 Payment Middleware
 *
 * Enforces micropayments on protected routes using the HTTP 402 protocol.
 *
 * Flow:
 *   1. Request arrives without X-PAYMENT header → return 402 with payment details
 *   2. Client pays (signs EIP-712), retries with X-PAYMENT header
 *   3. Middleware decodes and verifies the EIP-712 signature
 *   4. Nonce is stored to prevent replay attacks
 *   5. Request proceeds to the route handler
 */

import { Request, Response, NextFunction } from "express";
import { verifyTypedData, parseUnits, type Address } from "viem";

// ── Nonce registry (in-memory; replace with Redis in production) ───────────
const usedNonces = new Set<string>();

// ── EIP-712 domain + types (must match x402-client.ts in the frontend) ─────
const EIP712_DOMAIN = {
  name:    "x402Payment",
  version: "1",
} as const;

const EIP712_TYPES = {
  Payment: [
    { name: "payTo",  type: "address" },
    { name: "amount", type: "uint256" },
    { name: "token",  type: "address" },
    { name: "nonce",  type: "string"  },
  ],
} as const;

// ── Types ──────────────────────────────────────────────────────────────────

interface PaymentProof {
  from:      string;
  signature: `0x${string}`;
  amount:    string;
  token:     string;
  payTo:     string;
  nonce:     string;
}

export interface X402Options {
  /** USDC amount required for this endpoint (human-readable, e.g. "0.10") */
  amountUSDC: string;
}

// ── Middleware factory ─────────────────────────────────────────────────────

export function requirePayment(opts: X402Options) {
  return async function x402Guard(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    const SERVER_ADDRESS = process.env.SERVER_WALLET_ADDRESS as Address | undefined;
    const USDC_ADDRESS   = process.env.USDC_ADDRESS           as Address | undefined;
    const CHAIN_ID       = Number(process.env.CHAIN_ID ?? 421614);

    if (!SERVER_ADDRESS || !USDC_ADDRESS) {
      res.status(500).json({ error: "Server payment configuration missing" });
      return;
    }

    const paymentHeader = req.headers["x-payment"] as string | undefined;

    // ── Step 1: No payment header — issue 402 challenge ───────────────────
    if (!paymentHeader) {
      const nonce = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      res.status(402).json({
        amount:  opts.amountUSDC,
        payTo:   SERVER_ADDRESS,
        token:   USDC_ADDRESS,
        chainId: CHAIN_ID,
        nonce,
      });
      return;
    }

    // ── Step 2: Decode and validate payment proof ──────────────────────────
    let proof: PaymentProof;
    try {
      proof = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
    } catch {
      res.status(400).json({ error: "x402: malformed X-PAYMENT header" });
      return;
    }

    // Replay protection
    if (usedNonces.has(proof.nonce)) {
      res.status(402).json({ error: "x402: nonce already used" });
      return;
    }

    // Validate payTo matches this server's wallet
    if (proof.payTo.toLowerCase() !== SERVER_ADDRESS.toLowerCase()) {
      res.status(402).json({ error: "x402: payment not addressed to this server" });
      return;
    }

    // Validate amount meets the required threshold
    const paidRaw     = parseUnits(proof.amount, 6);
    const requiredRaw = parseUnits(opts.amountUSDC, 6);
    if (paidRaw < requiredRaw) {
      res.status(402).json({
        error:    `x402: insufficient payment — required $${opts.amountUSDC} USDC`,
        required: opts.amountUSDC,
        received: proof.amount,
      });
      return;
    }

    // ── Step 3: Verify EIP-712 signature ──────────────────────────────────
    try {
      const valid = await verifyTypedData({
        address:     proof.from as Address,
        domain:      { ...EIP712_DOMAIN, chainId: CHAIN_ID },
        types:       EIP712_TYPES,
        primaryType: "Payment",
        message: {
          payTo:  proof.payTo  as Address,
          amount: paidRaw,
          token:  proof.token  as Address,
          nonce:  proof.nonce,
        },
        signature: proof.signature,
      });

      if (!valid) {
        res.status(402).json({ error: "x402: invalid payment signature" });
        return;
      }
    } catch {
      res.status(402).json({ error: "x402: signature verification failed" });
      return;
    }

    // Mark nonce as used
    usedNonces.add(proof.nonce);

    // Attach payer info to request for downstream use
    (req as Request & { x402Payer?: string }).x402Payer = proof.from;

    next();
  };
}
