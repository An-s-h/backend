/**
 * Crossref API – works search (DOI registry, global publisher metadata).
 * @see https://api.crossref.org/
 */

import axios from "axios";

const cache = new Map();
const TTL_MS = 1000 * 60 * 5;

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

/**
 * Search Crossref works. Returns items in common publication shape.
 */
export async function searchCrossref({
  q = "",
  page = 1,
  pageSize = 25,
  sort = "relevance",
} = {}) {
  const query = (q || "").trim().replace(/\s+/g, " ");
  if (!query) return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };

  const key = `cr:${query}:${page}:${pageSize}:${sort}`;
  const cached = getCached(key);
  if (cached) return cached;

  const rows = Math.min(Number(pageSize) || 25, 100);
  const offset = (Math.max(1, Number(page)) - 1) * rows;

  try {
    const params = new URLSearchParams({
      query: query,
      rows: String(rows),
      offset: String(offset),
      sort: sort === "date" ? "published" : "relevance",
      order: "desc",
    });
    const url = `https://api.crossref.org/works?${params.toString()}`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });

    const items = (res.data?.message?.items || []).map((w) => {
      const doi = w.DOI || "";
      const title = (w.title || [])[0] || "";
      const authors = (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
      const pub = w.published || w["published-print"] || w["published-online"] || {};
      const dateParts = pub["date-parts"]?.[0] || [];
      const year = dateParts[0] ? String(dateParts[0]) : "";
      const abstract = w.abstract || "";
      const journal = (w["container-title"] || [])[0] || "";
      const link = w.URL || (doi ? `https://doi.org/${doi}` : "");

      return {
        source: "crossref",
        crossref_doi: doi,
        id: doi || "",
        doi,
        title,
        journal,
        year,
        authors,
        abstract: typeof abstract === "string" ? abstract : "",
        url: link,
        citationCount: null,
        funder: w.funder,
        referenceCount: w["reference-count"] ?? null,
      };
    });

    const total = res.data?.message?.["total-results"] ?? 0;
    const result = {
      items,
      totalCount: total,
      page: Number(page) || 1,
      pageSize: rows,
      hasMore: offset + items.length < total,
    };
    setCache(key, result);
    return result;
  } catch (err) {
    console.warn("Crossref search error:", err?.message);
    return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };
  }
}

/**
 * Get a single work by DOI. For publication detail page.
 */
export async function getWorkByDoi(doi) {
  const clean = (doi || "").trim().replace(/^https?:\/\/doi\.org\//i, "");
  if (!clean) return null;

  const key = `cr-get:${clean}`;
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const url = `https://api.crossref.org/works/${encodeURIComponent(clean)}`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });
    const w = res.data?.message;
    if (!w) return null;

    const title = (w.title || [])[0] || "";
    const authors = (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean);
    const pub = w.published || w["published-print"] || w["published-online"] || {};
    const dateParts = pub["date-parts"]?.[0] || [];
    const year = dateParts[0] ? String(dateParts[0]) : "";
    const abstract = w.abstract || "";
    const journal = (w["container-title"] || [])[0] || "";

    const out = {
      source: "crossref",
      crossref_doi: w.DOI,
      id: w.DOI,
      doi: w.DOI,
      title,
      journal,
      year,
      authors,
      abstract: typeof abstract === "string" ? abstract : "",
      url: w.URL || `https://doi.org/${w.DOI}`,
      funder: w.funder,
      referenceCount: w["reference-count"] ?? null,
      link: w.link,
    };
    setCache(key, out);
    return out;
  } catch (err) {
    if (err.response?.status !== 404) console.warn("Crossref get work error:", err?.message);
    return null;
  }
}
