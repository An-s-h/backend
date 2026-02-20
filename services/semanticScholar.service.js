/**
 * Semantic Scholar Academic Graph API – paper search, paper by ID/DOI, autocomplete.
 * @see https://api.semanticscholar.org/api-docs/
 * Paper search: GET /graph/v1/paper/search?query=...&offset=0&limit=100&fields=...
 * Limits: without API key 100 req/5min; limit must be <= 100. Hyphenated terms yield no matches (use spaces).
 */

import axios from "axios";

const cache = new Map();
const TTL_MS = 1000 * 60 * 5;
const AUTOCOMPLETE_CACHE_TTL_MS = 1000 * 60 * 2;

function getCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() > e.expires) {
    if (e) cache.delete(key);
    return null;
  }
  return e.value;
}
function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + TTL_MS });
}

const FIELDS =
  "paperId,title,authors,year,abstract,citationCount,influentialCitationCount,url,openAccessPdf,externalIds,venue";

function prepareQuery(q) {
  return (q || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/-/g, " ");
}

async function requestWithRetry(url, headers, maxRetries = 2) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 15000, headers, validateStatus: () => true });
      if (res.status === 429) {
        const delay = (attempt + 1) * 4000;
        if (attempt < maxRetries) {
          console.warn("Semantic Scholar rate limit (429), retrying in", delay, "ms");
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return res;
    } catch (err) {
      if (attempt === maxRetries) throw err;
      await new Promise((r) => setTimeout(r, (attempt + 1) * 2000));
    }
  }
  return null;
}

/**
 * Search papers. Returns items in common publication shape.
 * API: limit must be <= 100; hyphenated query terms yield no matches.
 */
export async function searchSemanticScholar({
  q = "",
  page = 1,
  pageSize = 25,
} = {}) {
  const query = prepareQuery(q);
  if (!query) return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };

  const key = `ss:${query}:${page}:${pageSize}`;
  const cached = getCached(key);
  if (cached) return cached;

  const limit = Math.min(Math.max(1, Number(pageSize) || 25), 100);
  const offset = Math.max(0, (Math.max(1, Number(page)) - 1) * limit);

  try {
    const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(
      query
    )}&offset=${offset}&limit=${limit}&fields=${encodeURIComponent(FIELDS)}`;
    const headers = {
      "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)",
      Accept: "application/json",
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await requestWithRetry(url, headers);
    if (!res || res.status !== 200) {
      const msg = res?.data?.message || res?.statusText || res?.status;
      console.warn("Semantic Scholar search error:", res?.status, msg);
      return { items: [], totalCount: 0, page: 1, pageSize: limit, hasMore: false };
    }

    const data = res.data?.data || [];
    const total = res.data?.total ?? 0;

    const items = data.map((p) => {
      const doi = p.externalIds?.DOI || "";
      const pmid = p.externalIds?.PubMed || "";
      const authors = (p.authors || []).map((a) => a.name).filter(Boolean);
      const pdfUrl = p.openAccessPdf?.url || null;
      const venue =
        typeof p.venue === "string" ? p.venue : p.venue?.name || p.publicationVenue?.name || "";

      return {
        source: "semantic_scholar",
        semantic_scholar_id: p.paperId || "",
        id: p.paperId || pmid || doi || "",
        pmid: pmid || undefined,
        title: p.title || "",
        journal: venue,
        year: p.year ? String(p.year) : "",
        authors,
        doi: doi || undefined,
        abstract: p.abstract || "",
        url: p.url || (doi ? `https://doi.org/${doi}` : ""),
        citationCount: p.citationCount ?? 0,
        influentialCitationCount: p.influentialCitationCount ?? null,
        openAccessPdf: pdfUrl,
        openAccessPdfStatus: p.openAccessPdf?.status || null,
      };
    });

    const result = {
      items,
      totalCount: total,
      page: Number(page) || 1,
      pageSize: limit,
      hasMore: offset + items.length < total,
    };
    setCache(key, result);
    return result;
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data;
    console.warn(
      "Semantic Scholar search error:",
      err?.message,
      status ? `status=${status}` : "",
      body ? JSON.stringify(body).slice(0, 200) : "",
    );
    return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };
  }
}

/**
 * Paper autocomplete – suggests papers by prefix for search UX.
 * GET /graph/v1/paper/autocomplete?query=...
 */
function getAutocompleteCached(key) {
  const e = cache.get(key);
  if (!e || Date.now() > e.expires) {
    if (e) cache.delete(key);
    return null;
  }
  return e.value;
}
function setAutocompleteCache(key, value) {
  cache.set(key, { value, expires: Date.now() + AUTOCOMPLETE_CACHE_TTL_MS });
}

export async function autocompletePapers(query = "") {
  const q = prepareQuery(query).slice(0, 200);
  if (!q || q.length < 2) return { matches: [] };

  const key = `ss-ac:${q}`;
  const cached = getAutocompleteCached(key);
  if (cached) return cached;

  try {
    const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
    const url = `https://api.semanticscholar.org/graph/v1/paper/autocomplete?query=${encodeURIComponent(q)}`;
    const headers = {
      "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)",
      Accept: "application/json",
    };
    if (apiKey) headers["x-api-key"] = apiKey;

    const res = await axios.get(url, { timeout: 8000, headers, validateStatus: () => true });
    if (res.status !== 200) {
      return { matches: [] };
    }
    const raw = res.data?.matches || [];
    const matches = raw
      .map((m) => ({
        id: m.id || "",
        title: (m.title || "").trim(),
        authorsYear: (m.authorsYear || "").trim(),
      }))
      .filter((m) => m.id && m.title);
    const result = { matches };
    setAutocompleteCache(key, result);
    return result;
  } catch (err) {
    console.warn("Semantic Scholar autocomplete error:", err?.message);
    return { matches: [] };
  }
}

/**
 * Get a single paper by Semantic Scholar paperId or by DOI/PMID (externalIds lookup).
 * Supported ID formats: paperId, DOI:10.123/..., PMID:12345
 */
export async function getPaperByIdOrDoi(idOrDoi) {
  const raw = (idOrDoi || "").trim();
  if (!raw) return null;

  const key = `ss-get:${raw}`;
  const cached = getCached(key);
  if (cached) return cached;

  const apiKey = process.env.SEMANTIC_SCHOLAR_API_KEY || "";
  const fields = `${FIELDS},s2FieldsOfStudy`;
  let url;
  if (/^10\.\d+\//.test(raw) || raw.toLowerCase().startsWith("doi/")) {
    const doi = raw.replace(/^doi\//i, "").trim();
    url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=${encodeURIComponent(fields)}`;
  } else if (/^\d+$/.test(raw)) {
    url = `https://api.semanticscholar.org/graph/v1/paper/PMID:${raw}?fields=${encodeURIComponent(fields)}`;
  } else {
    url = `https://api.semanticscholar.org/graph/v1/paper/${encodeURIComponent(raw)}?fields=${encodeURIComponent(fields)}`;
  }

  try {
    const headers = {
      "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)",
      Accept: "application/json",
    };
    if (apiKey) headers["x-api-key"] = apiKey;
    const res = await axios.get(url, { timeout: 10000, headers, validateStatus: () => true });
    if (res.status !== 200) {
      if (res.status !== 404) {
        console.warn("Semantic Scholar get paper:", res.status, res.data?.message || res.statusText);
      }
      return null;
    }
    const p = res.data;
    if (!p || !p.paperId) return null;

    const doi = p.externalIds?.DOI || "";
    const pmid = p.externalIds?.PubMed || "";
    const authors = (p.authors || []).map((a) => a.name).filter(Boolean);

    const out = {
      source: "semantic_scholar",
      semantic_scholar_id: p.paperId,
      id: p.paperId,
      pmid: pmid || undefined,
      title: p.title || "",
      journal: typeof p.venue === "string" ? p.venue : p.venue?.name || p.publicationVenue?.name || "",
      year: p.year ? String(p.year) : "",
      authors,
      doi: doi || undefined,
      abstract: p.abstract || "",
      url: p.url || (doi ? `https://doi.org/${doi}` : ""),
      citationCount: p.citationCount ?? 0,
      influentialCitationCount: p.influentialCitationCount ?? null,
      openAccessPdf: p.openAccessPdf?.url || null,
      openAccessPdfStatus: p.openAccessPdf?.status || null,
      openAccessPdfLicense: p.openAccessPdf?.license || null,
      s2FieldsOfStudy: p.s2FieldsOfStudy || [],
    };
    setCache(key, out);
    return out;
  } catch (err) {
    if (err.response?.status !== 404) console.warn("Semantic Scholar get paper error:", err?.message);
    return null;
  }
}
