/**
 * OpenSanctions API Wrapper
 *
 * OpenSanctions aggregates sanctions lists from 100+ jurisdictions.
 * Free tier: 10,000 requests/month.
 * Reference: https://www.opensanctions.org/api/
 *
 * Used as a secondary screening source alongside OFAC.
 * Falls back gracefully when OPENSANCTIONS_API_KEY is not set.
 */

import axios from "axios";

const BASE_URL = "https://api.opensanctions.org";

export interface OpenSanctionsEntity {
  id:         string;
  caption:    string;
  schema:     string;
  score:      number;
  datasets:   string[];
  properties: Record<string, string[]>;
}

export interface OpenSanctionsResult {
  query:       string;
  available:   boolean;
  results:     OpenSanctionsEntity[];
  isSanctioned: boolean;
  source:      "OpenSanctions";
}

/**
 * Match a name or entity against the OpenSanctions database.
 * Returns an empty result if no API key is configured.
 */
export async function screenAgainstOpenSanctions(
  query: string
): Promise<OpenSanctionsResult> {
  const apiKey = process.env.OPENSANCTIONS_API_KEY;

  if (!apiKey) {
    return { query, available: false, results: [], isSanctioned: false, source: "OpenSanctions" };
  }

  try {
    const { data } = await axios.post(
      `${BASE_URL}/match/default`,
      {
        queries: {
          q1: {
            schema: "Thing",
            properties: { name: [query] },
          },
        },
      },
      {
        headers: {
          Authorization: `ApiKey ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 8_000,
      }
    );

    const results: OpenSanctionsEntity[] = data?.responses?.q1?.results ?? [];
    const isSanctioned = results.some((r) => r.score >= 0.8);

    return { query, available: true, results, isSanctioned, source: "OpenSanctions" };
  } catch (err) {
    console.error("[opensanctions] API call failed:", err);
    return { query, available: false, results: [], isSanctioned: false, source: "OpenSanctions" };
  }
}
