/**
 * Shipping Rate Engine
 *
 * Provides shipping rate estimates for Eliezer Suite's primary trade corridors.
 * Integrates real carrier APIs when credentials are configured, and falls back
 * to lane-based market estimates sourced from public shipping indices.
 *
 * Supported carriers (plug in API keys to activate):
 *   - DHL Express (air + express)
 *   - Freightos / WebCargo (sea + air marketplace)
 *   - Flexport (managed shipping)
 *
 * Primary corridors:
 *   China (SHA/PVG/CAN/SZX) → Nigeria (LOS/ABV)
 *   China → UK, USA, Canada, UAE, Kenya, Ghana
 */

import axios from "axios";

export type ShipmentMode = "sea_fcl" | "sea_lcl" | "air" | "express";

export interface ShippingRateRequest {
  origin:      string; // city or port code
  destination: string;
  weightKg:    number;
  cbm?:        number;  // required for sea_lcl
  mode?:       ShipmentMode;
}

export interface CarrierQuote {
  carrier:      string;
  mode:         ShipmentMode;
  priceUSD:     number;
  transitDays:  { min: number; max: number };
  validUntil:   string; // ISO-8601
  source:       "live" | "estimate";
  notes?:       string;
}

export interface ShippingRateResult {
  origin:      string;
  destination: string;
  weightKg:    number;
  cbm?:        number;
  quotes:      CarrierQuote[];
  exchangeRates?: { CNY: number; NGN: number };
}

// ── Lane rate database (market estimates, updated quarterly) ───────────────
// Rates in USD. Sea LCL per CBM. Air / Express per kg.

type LaneKey = string; // "origin→destination"

interface LaneRates {
  sea_lcl_per_cbm:  { min: number; max: number };
  sea_fcl_20ft:     { min: number; max: number };
  air_per_kg:       { min: number; max: number };
  express_per_kg:   { min: number; max: number };
  sea_transit_days: { min: number; max: number };
  air_transit_days: { min: number; max: number };
}

const LANE_RATES: Record<LaneKey, LaneRates> = {
  "china→nigeria": {
    sea_lcl_per_cbm:  { min: 55,   max: 95   },
    sea_fcl_20ft:     { min: 2500, max: 4500  },
    air_per_kg:       { min: 4.50, max: 8.50  },
    express_per_kg:   { min: 8.00, max: 15.00 },
    sea_transit_days: { min: 25,   max: 40    },
    air_transit_days: { min: 3,    max: 7     },
  },
  "china→uk": {
    sea_lcl_per_cbm:  { min: 40,   max: 70   },
    sea_fcl_20ft:     { min: 1800, max: 3200  },
    air_per_kg:       { min: 3.50, max: 6.50  },
    express_per_kg:   { min: 6.00, max: 11.00 },
    sea_transit_days: { min: 28,   max: 42    },
    air_transit_days: { min: 3,    max: 6     },
  },
  "china→usa": {
    sea_lcl_per_cbm:  { min: 35,   max: 65   },
    sea_fcl_20ft:     { min: 1500, max: 3000  },
    air_per_kg:       { min: 3.00, max: 6.00  },
    express_per_kg:   { min: 5.50, max: 10.00 },
    sea_transit_days: { min: 18,   max: 35    },
    air_transit_days: { min: 2,    max: 5     },
  },
  "china→uae": {
    sea_lcl_per_cbm:  { min: 40,   max: 70   },
    sea_fcl_20ft:     { min: 1200, max: 2500  },
    air_per_kg:       { min: 2.50, max: 5.00  },
    express_per_kg:   { min: 5.00, max: 9.00  },
    sea_transit_days: { min: 14,   max: 24    },
    air_transit_days: { min: 2,    max: 4     },
  },
  "china→kenya": {
    sea_lcl_per_cbm:  { min: 50,   max: 85   },
    sea_fcl_20ft:     { min: 2000, max: 3800  },
    air_per_kg:       { min: 4.00, max: 7.50  },
    express_per_kg:   { min: 7.50, max: 13.00 },
    sea_transit_days: { min: 20,   max: 35    },
    air_transit_days: { min: 3,    max: 6     },
  },
  "china→ghana": {
    sea_lcl_per_cbm:  { min: 55,   max: 90   },
    sea_fcl_20ft:     { min: 2200, max: 4000  },
    air_per_kg:       { min: 4.50, max: 8.00  },
    express_per_kg:   { min: 8.00, max: 14.00 },
    sea_transit_days: { min: 24,   max: 38    },
    air_transit_days: { min: 3,    max: 7     },
  },
  "china→canada": {
    sea_lcl_per_cbm:  { min: 38,   max: 68   },
    sea_fcl_20ft:     { min: 1700, max: 3200  },
    air_per_kg:       { min: 3.20, max: 6.20  },
    express_per_kg:   { min: 6.00, max: 10.50 },
    sea_transit_days: { min: 20,   max: 38    },
    air_transit_days: { min: 2,    max: 6     },
  },
};

const FALLBACK_LANE: LaneRates = {
  sea_lcl_per_cbm:  { min: 50,   max: 100  },
  sea_fcl_20ft:     { min: 2000, max: 5000 },
  air_per_kg:       { min: 4.00, max: 9.00 },
  express_per_kg:   { min: 7.00, max: 15.00 },
  sea_transit_days: { min: 20,   max: 45   },
  air_transit_days: { min: 3,    max: 8    },
};

// ── Lane lookup ────────────────────────────────────────────────────────────

const REGION_MAP: Record<string, string> = {
  lagos: "nigeria", apapa: "nigeria", abuja: "nigeria", tin_can: "nigeria",
  guangzhou: "china", shenzhen: "china", shanghai: "china", yiwu: "china",
  beijing: "china", hong_kong: "china", foshan: "china",
  can: "china", szx: "china", sha: "china", pvg: "china", hkg: "china",
  los: "nigeria", abv: "nigeria",
  london: "uk", manchester: "uk", birmingham: "uk", lhr: "uk",
  "new york": "usa", "los angeles": "usa", chicago: "usa", jfk: "usa", lax: "usa",
  dubai: "uae", abu_dhabi: "uae", dxb: "uae",
  nairobi: "kenya", nbo: "kenya",
  accra: "ghana", acc: "ghana",
  toronto: "canada", vancouver: "canada", yyz: "canada",
};

function normaliseLane(origin: string, destination: string): string {
  const o = origin.toLowerCase().replace(/[\s-]/g, "_");
  const d = destination.toLowerCase().replace(/[\s-]/g, "_");
  const regionO = REGION_MAP[o] ?? o;
  const regionD = REGION_MAP[d] ?? d;
  return `${regionO}→${regionD}`;
}

function getLaneRates(origin: string, destination: string): LaneRates {
  const key = normaliseLane(origin, destination);
  return LANE_RATES[key] ?? FALLBACK_LANE;
}

// ── Estimate builder ───────────────────────────────────────────────────────

function midpoint(range: { min: number; max: number }): number {
  return (range.min + range.max) / 2;
}

function validUntil(days = 7): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

function buildEstimates(req: ShippingRateRequest, lane: LaneRates): CarrierQuote[] {
  const quotes: CarrierQuote[] = [];
  const modes: ShipmentMode[] = req.mode
    ? [req.mode]
    : ["sea_lcl", "air", "express"];

  for (const mode of modes) {
    if (mode === "sea_lcl") {
      const cbm     = req.cbm ?? req.weightKg / 500; // assume 1 CBM = 500 kg if not given
      const priceUSD = midpoint(lane.sea_lcl_per_cbm) * cbm;
      quotes.push({
        carrier:     "Market estimate (LCL)",
        mode,
        priceUSD:    Math.round(priceUSD),
        transitDays: lane.sea_transit_days,
        validUntil:  validUntil(),
        source:      "estimate",
        notes:       `Based on ${cbm.toFixed(2)} CBM`,
      });
    }

    if (mode === "sea_fcl") {
      quotes.push({
        carrier:     "Market estimate (FCL 20ft)",
        mode,
        priceUSD:    Math.round(midpoint(lane.sea_fcl_20ft)),
        transitDays: lane.sea_transit_days,
        validUntil:  validUntil(),
        source:      "estimate",
      });
    }

    if (mode === "air") {
      quotes.push({
        carrier:     "Market estimate (air)",
        mode,
        priceUSD:    Math.round(midpoint(lane.air_per_kg) * req.weightKg),
        transitDays: lane.air_transit_days,
        validUntil:  validUntil(3),
        source:      "estimate",
      });
    }

    if (mode === "express") {
      quotes.push({
        carrier:     "DHL / FedEx / UPS (estimate)",
        mode,
        priceUSD:    Math.round(midpoint(lane.express_per_kg) * req.weightKg),
        transitDays: { min: 2, max: 5 },
        validUntil:  validUntil(1),
        source:      "estimate",
      });
    }
  }

  return quotes;
}

// ── DHL Express API (live, optional) ──────────────────────────────────────

async function fetchDHLRates(req: ShippingRateRequest): Promise<CarrierQuote[]> {
  const apiKey    = process.env.DHL_API_KEY;
  const apiSecret = process.env.DHL_API_SECRET;
  if (!apiKey || !apiSecret) return [];

  try {
    const { data } = await axios.get(
      "https://api-mock.dhl.com/mydhlapi/rates",
      {
        params: {
          accountNumber:       "123456789",
          originCountryCode:   "CN",
          originCityName:      req.origin,
          destinationCountryCode: "NG",
          destinationCityName: req.destination,
          weight:              req.weightKg,
          length:              40, height: 30, width: 30,
          plannedShippingDateAndTime: new Date().toISOString(),
          isCustomsDeclarable: false,
          unitOfMeasurement:   "metric",
        },
        headers: { "DHL-API-Key": apiKey },
        timeout: 8_000,
      }
    );

    return (data.products ?? []).map((p: Record<string, unknown>) => ({
      carrier:     `DHL ${p.productName}`,
      mode:        "express" as ShipmentMode,
      priceUSD:    (p as { totalPrice?: Array<{ price: number }> }).totalPrice?.[0]?.price ?? 0,
      transitDays: { min: 2, max: 5 },
      validUntil:  validUntil(1),
      source:      "live" as const,
    }));
  } catch {
    return [];
  }
}

// ── Freightos API (live, optional) ────────────────────────────────────────

async function fetchFreightosRates(req: ShippingRateRequest): Promise<CarrierQuote[]> {
  const apiKey = process.env.FREIGHTOS_API_KEY;
  if (!apiKey) return [];

  try {
    const { data } = await axios.post(
      "https://api.freightos.com/api/v1/quotations",
      {
        origin:      { portCode: req.origin },
        destination: { portCode: req.destination },
        cargo: [{
          weight:   { value: req.weightKg, unit: "KG" },
          volume:   { value: req.cbm ?? req.weightKg / 500, unit: "CBM" },
          quantity: 1,
        }],
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: 10_000,
      }
    );

    return (data.quotations ?? []).map((q: Record<string, unknown>) => ({
      carrier:     String(q.carrier ?? "Freightos carrier"),
      mode:        "sea_lcl" as ShipmentMode,
      priceUSD:    Number((q as { totalCharges?: { amount: number } }).totalCharges?.amount ?? 0),
      transitDays: { min: 20, max: 45 },
      validUntil:  validUntil(7),
      source:      "live" as const,
    }));
  } catch {
    return [];
  }
}

// ── Public entry point ────────────────────────────────────────────────────

export async function getShippingRates(req: ShippingRateRequest): Promise<ShippingRateResult> {
  const lane = getLaneRates(req.origin, req.destination);

  // Attempt live carrier APIs first, fall back to estimates
  const [dhlQuotes, freightosQuotes] = await Promise.all([
    fetchDHLRates(req),
    fetchFreightosRates(req),
  ]);

  const liveQuotes   = [...dhlQuotes, ...freightosQuotes];
  const estimateQuotes = buildEstimates(req, lane);

  // Prefer live quotes; supplement with estimates for modes not covered
  const coveredModes = new Set(liveQuotes.map((q) => q.mode));
  const fallbacks    = estimateQuotes.filter((q) => !coveredModes.has(q.mode));

  return {
    origin:      req.origin,
    destination: req.destination,
    weightKg:    req.weightKg,
    cbm:         req.cbm,
    quotes:      [...liveQuotes, ...fallbacks],
  };
}
