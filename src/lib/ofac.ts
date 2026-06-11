/**
 * OFAC SDN List — Fetcher and Screener
 *
 * Downloads the US Treasury OFAC Specially Designated Nationals list,
 * caches it in memory, and exposes a name/entity screening function.
 *
 * The full SDN list is public domain and refreshed every 24 hours.
 * Reference: https://ofac.treasury.gov/sanctions-list-service
 */

import axios     from "axios";
import NodeCache from "node-cache";

const SDN_URL   = "https://www.treasury.gov/ofac/downloads/sdn.csv";
const CACHE_TTL = Number(process.env.OFAC_REFRESH_INTERVAL_MS ?? 86_400_000) / 1000;

const cache = new NodeCache({ stdTTL: CACHE_TTL });

interface SdnEntry {
  name:        string;
  type:        string; // "Individual" | "Entity" | "Vessel" | "Aircraft"
  programs:    string; // sanction programs (e.g. "IRAN", "RUSSIA")
  nationality: string;
}

// ── CSV parser for the OFAC SDN list ──────────────────────────────────────

function parseSdnCsv(csv: string): SdnEntry[] {
  const entries: SdnEntry[] = [];
  const lines = csv.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    // OFAC CSV columns: UID, Name, Type, Programs, ..., Nationality, ...
    // Split respecting quoted fields
    const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g) ?? [];
    const clean = (s?: string) => (s ?? "").replace(/^"|"$/g, "").trim();

    const name        = clean(cols[1]);
    const type        = clean(cols[2]);
    const programs    = clean(cols[3]);
    const nationality = clean(cols[9] ?? "");

    if (name) {
      entries.push({ name, type, programs, nationality });
    }
  }

  return entries;
}

// ── Fetch + cache ──────────────────────────────────────────────────────────

async function getSdnList(): Promise<SdnEntry[]> {
  const cached = cache.get<SdnEntry[]>("sdn");
  if (cached) return cached;

  try {
    const { data } = await axios.get<string>(SDN_URL, {
      responseType: "text",
      timeout:      15_000,
    });
    const entries = parseSdnCsv(data);
    cache.set("sdn", entries);
    console.log(`[ofac] Loaded ${entries.length} SDN entries`);
    return entries;
  } catch (err) {
    console.error("[ofac] Failed to fetch SDN list:", err);
    return [];
  }
}

// ── Screening ──────────────────────────────────────────────────────────────

export interface ScreeningHit {
  name:        string;
  type:        string;
  programs:    string;
  nationality: string;
  score:       number; // 0–100 similarity score
}

export interface OFACResult {
  query:       string;
  hits:        ScreeningHit[];
  isSanctioned: boolean;
  source:      "OFAC-SDN";
}

/**
 * Simple token-based similarity score (0–100).
 * Production should use phonetic matching (Soundex, Jaro-Winkler).
 */
function similarity(a: string, b: string): number {
  const tokA = a.toLowerCase().split(/\s+/);
  const tokB = b.toLowerCase().split(/\s+/);
  const common = tokA.filter((t) => tokB.includes(t)).length;
  return Math.round((common / Math.max(tokA.length, tokB.length)) * 100);
}

/**
 * Screen a name or entity against the OFAC SDN list.
 * Returns all hits with a similarity score above the threshold.
 */
export async function screenAgainstOFAC(
  query:     string,
  threshold: number = 70
): Promise<OFACResult> {
  const list = await getSdnList();

  const hits: ScreeningHit[] = list
    .map((entry) => ({ ...entry, score: similarity(query, entry.name) }))
    .filter((h) => h.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10); // top 10 matches

  return {
    query,
    hits,
    isSanctioned: hits.some((h) => h.score >= 85),
    source:       "OFAC-SDN",
  };
}
