/**
 * Exchange Rate Service
 *
 * Fetches live USD → CNY / NGN rates for displaying freight quotes
 * in local currencies alongside the USDC equivalent.
 *
 * Uses ExchangeRate-API (free tier: 1,500 requests/month).
 * Falls back to hardcoded reference rates when the API is unavailable.
 *
 * Reference: https://www.exchangerate-api.com
 */

import axios     from "axios";
import NodeCache from "node-cache";

const cache    = new NodeCache({ stdTTL: 3600 }); // cache for 1 hour
const BASE_URL = "https://v6.exchangerate-api.com/v6";

interface RateMap {
  CNY: number;
  NGN: number;
  USD: number;
  [key: string]: number;
}

// Fallback rates (updated periodically — not for production financial use)
const FALLBACK_RATES: RateMap = {
  USD: 1,
  CNY: 7.25,
  NGN: 1600,
};

export async function getExchangeRates(): Promise<RateMap> {
  const cached = cache.get<RateMap>("rates");
  if (cached) return cached;

  const apiKey = process.env.EXCHANGE_RATE_API_KEY;
  if (!apiKey) return FALLBACK_RATES;

  try {
    const { data } = await axios.get(`${BASE_URL}/${apiKey}/latest/USD`, {
      timeout: 5_000,
    });

    const rates: RateMap = {
      USD: 1,
      CNY: data.conversion_rates?.CNY ?? FALLBACK_RATES.CNY,
      NGN: data.conversion_rates?.NGN ?? FALLBACK_RATES.NGN,
    };

    cache.set("rates", rates);
    return rates;
  } catch {
    return FALLBACK_RATES;
  }
}

export function convertUSD(amountUSD: number, rates: RateMap) {
  return {
    USD: amountUSD,
    CNY: +(amountUSD * rates.CNY).toFixed(2),
    NGN: +(amountUSD * rates.NGN).toFixed(0),
  };
}
