# eliezer-suite-api

Agent API server for Eliezer Suite. Provides live shipping rates and sanctions screening data to the AI agent layer, protected by the [x402 payment protocol](https://x402.org). Built with Express and TypeScript, deployed on Railway.

---

## What it does

The Eliezer Suite AI assistant routes shipping and compliance queries through this server before calling OpenRouter, so the model reasons over real data — not just general knowledge.

**`POST /shipping/rates`** — returns shipping quotes for a trade corridor. Eliezer Suite sets and maintains its own rates across sea (LCL and FCL), air, and express modes for the corridors it serves. Quotes are returned in USD, CNY, and NGN.

**`POST /compliance/screen`** — screens a party name or entity against the OFAC Specially Designated Nationals list (US Treasury, downloaded and cached) and the OpenSanctions database (100+ jurisdictions). Returns a match report with a clear `isSanctioned` flag.

**`GET /rates/exchange`** — public endpoint, no payment required. Returns live USD → CNY / NGN exchange rates, cached hourly, for display in the frontend alongside USDC quotes.

---

## x402 Payment Protocol

Both agent endpoints are protected by [x402](https://x402.org) — the HTTP 402 payment standard by Coinbase.

**Flow:**
1. Agent calls `/shipping/rates` or `/compliance/screen` without a payment header
2. Server returns **HTTP 402** with payment details: `{ amount, payTo, token, chainId, nonce }`
3. Agent signs an EIP-712 payment authorization with the Eliezer Suite agent wallet
4. Agent retries the request with the `X-PAYMENT` header containing the base64-encoded signature
5. Server verifies the EIP-712 signature using viem's `verifyTypedData`
6. Nonce is marked as used (replay protection) and the request is served

Payments are made in USDC on Arbitrum. No intermediary, no subscription — each API call pays directly to the server wallet.

---

## Supported Corridors

Rates cover the corridors Eliezer Suite actively serves:

| From | To |
|---|---|
| China (Guangzhou, Shenzhen, Shanghai, Yiwu, Hong Kong) | Nigeria (Lagos, Abuja) |
| China | United Kingdom |
| China | United States |
| China | UAE (Dubai) |
| China | Kenya (Nairobi) |
| China | Ghana (Accra) |
| China | Canada (Toronto, Vancouver) |

Rates include sea LCL (per CBM), sea FCL (20ft container), air (per kg), and express (per kg). Transit time ranges are included per mode.

---

## Project Structure

```
src/
├── index.ts                  Express app — registers routes, starts server
├── middleware/
│   └── x402.ts              HTTP 402 challenge + EIP-712 signature verification
├── routes/
│   ├── shipping.ts          POST /shipping/rates
│   ├── compliance.ts        POST /compliance/screen
│   └── rates.ts             GET  /rates/exchange
└── lib/
    ├── shipping-rates.ts    Lane rate table + quote builder (Eliezer Suite own rates)
    ├── ofac.ts              OFAC SDN list download, parse, cache, name screening
    ├── opensanctions.ts     OpenSanctions API wrapper (optional, free tier)
    └── exchange-rates.ts    ExchangeRate-API wrapper with 1-hour cache
```

---

## Setup

```bash
npm install
cp .env.example .env
# Fill in .env — see variables below
npm run dev
```

**Build for production:**
```bash
npm run build
npm start
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | No | Server port (default `3100`) |
| `SERVER_WALLET_ADDRESS` | Yes | Wallet address that receives x402 USDC payments |
| `USDC_ADDRESS` | Yes | USDC contract on the configured chain |
| `CHAIN_ID` | No | `421614` for Arbitrum Sepolia, `42161` for Arbitrum One (default `421614`) |
| `SHIPPING_RATE_PRICE_USDC` | No | USDC charged per `/shipping/rates` call (default `0.10`) |
| `COMPLIANCE_SCREEN_PRICE_USDC` | No | USDC charged per `/compliance/screen` call (default `0.05`) |
| `OPENSANCTIONS_API_KEY` | No | OpenSanctions API key — free tier at [opensanctions.org](https://www.opensanctions.org/api/). Falls back to OFAC-only screening if unset |
| `OFAC_REFRESH_INTERVAL_MS` | No | How often to re-fetch the OFAC SDN list in ms (default `86400000` = 24h) |
| `EXCHANGE_RATE_API_KEY` | No | ExchangeRate-API key — [exchangerate-api.com](https://www.exchangerate-api.com) free tier. Falls back to hardcoded reference rates if unset |

**USDC addresses:**
- Arbitrum Sepolia: `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`
- Arbitrum One: `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`

---

## API Reference

### POST /shipping/rates
Protected by x402. Requires USDC payment per call.

**Request body:**
```json
{ "query": "ship 80kg from guangzhou to lagos by sea" }
```

**Response:**
```json
{
  "origin": "guangzhou",
  "destination": "lagos",
  "weightKg": 80,
  "quotes": [
    {
      "carrier": "Market estimate (LCL)",
      "mode": "sea_lcl",
      "priceUSD": 596,
      "priceConverted": { "USD": 596, "CNY": 4321, "NGN": 953600 },
      "transitDays": { "min": 25, "max": 40 },
      "validUntil": "2026-06-18T...",
      "source": "eliezer"
    }
  ],
  "exchangeRates": { "CNY": 7.25, "NGN": 1600 },
  "paidBy": "0x..."
}
```

### POST /compliance/screen
Protected by x402. Requires USDC payment per call.

**Request body:**
```json
{ "query": "Alibaba Group Holding Limited" }
```

**Response:**
```json
{
  "query": "Alibaba Group Holding Limited",
  "isSanctioned": false,
  "summary": "No sanctions matches found...",
  "ofac": { "hits": [], "isSanctioned": false, "source": "OFAC-SDN" },
  "openSanctions": { "available": true, "results": [], "isSanctioned": false },
  "screenedAt": "2026-06-11T12:00:00.000Z",
  "paidBy": "0x..."
}
```

### GET /rates/exchange
No payment required.

**Response:**
```json
{
  "base": "USD",
  "rates": { "CNY": 7.25, "NGN": 1600 },
  "updatedAt": "2026-06-11T12:00:00.000Z"
}
```

---

## Updating Rates

Shipping rates are set in `src/lib/shipping-rates.ts` in the `LANE_RATES` table. Each lane entry has per-mode price ranges (min/max) and transit day ranges. The served quote uses the midpoint of each range.

To update a lane rate, edit the relevant entry and redeploy.

---

## Architecture

See the [interactive system architecture diagram](https://eliezer-suite.netlify.app/architecture.html) for how this server fits into the full Eliezer Suite stack.

This server sits between the AI agent layer and the blockchain layer. Shipping and compliance agents query it via x402 before calling OpenRouter, enriching the AI prompt with live data. The OFAC SDN list and OpenSanctions database are the external data sources it wraps.

---

## Related Repositories

| Repository | Description |
|---|---|
| [`eliezer-suite-contracts`](https://github.com/Havilah-Blockchain-Studios/eliezer-suite-contracts) | Solidity contracts — ShipmentRegistry, ShippingEscrow, ComplianceRecord, and more |
| [`eliezer-suite-frontend`](https://github.com/kingfavourjudah/eliezer-suite-website) | Next.js 14 frontend — dashboard, escrow UI, AI assistant, governance |
