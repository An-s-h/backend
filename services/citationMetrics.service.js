/**
 * Citation metrics enrichment (NIH iCite).
 * Fetches citation_count and relative_citation_ratio (RCR) per PMID; results cached with batch cache.
 */

import axios from "axios";

const ICITE_BASE = "https://icite.od.nih.gov/api";
const CACHE = new Map();
const CACHE_TTL_MS = 1000 * 60 * 10; // 10 minutes

function cacheKey(pmids) {
  return `icite:${[...pmids].sort((a, b) => a - b).join(",")}`;
}

function getCached(key) {
  const entry = CACHE.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    CACHE.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  CACHE.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

const BATCH_SIZE = 200;

/**
 * Fetch citation metrics for a list of PMIDs from NIH iCite.
 * @param {string[]} pmids - Array of PMID strings
 * @returns {Promise<Map<string, { citationCount: number, rcr: number | null }>>} - Map of pmid -> metrics
 */
export async function fetchCitationMetrics(pmids) {
  if (!pmids || pmids.length === 0) return new Map();

  const unique = [...new Set(pmids.map(String).filter(Boolean))];
  const key = cacheKey(unique);
  const cached = getCached(key);
  if (cached) return cached;

  const result = new Map();

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const pmidsParam = batch.join(",");

    try {
      const url = `${ICITE_BASE}/pubs?pmids=${pmidsParam}&format=json`;
      const { data } = await axios.get(url, {
        timeout: 15000,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; CuraLink/1.0)" },
      });

      const list = data?.data;
      if (Array.isArray(list)) {
        for (const row of list) {
          const pmid = String(row.pmid ?? row._id ?? "");
          if (!pmid) continue;
          result.set(pmid, {
            citationCount: Number(row.citation_count) || 0,
            rcr: row.relative_citation_ratio != null ? Number(row.relative_citation_ratio) : null,
          });
        }
      }
    } catch (err) {
      console.warn("iCite batch fetch failed:", err.message);
      // Leave missing PMIDs without metrics; do not fail the whole request
    }
  }

  setCache(key, result);
  return result;
}
