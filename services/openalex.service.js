/**
 * OpenAlex API service – search works (publications) and normalize to shared publication shape.
 * Used alongside PubMed to broaden publication coverage.
 * @see https://docs.openalex.org/api-entities/works/search-works
 * @see https://docs.openalex.org/how-to-use-the-api/api-overview
 */

import axios from "axios";

const cache = new Map();
const TTL_MS = 1000 * 60 * 5; // 5 minutes

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + TTL_MS });
}
function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

/**
 * Reconstruct plain-text abstract from OpenAlex abstract_inverted_index.
 * Format: { "word1": [0, 5], "word2": [1, 6], ... } -> "word1 word2 ..." (by position).
 * @param {Record<string, number[]>} invertedIndex
 * @returns {string}
 */
function abstractFromInvertedIndex(invertedIndex) {
  if (!invertedIndex || typeof invertedIndex !== "object") return "";
  const pairs = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const pos of positions) {
      pairs.push({ word, pos });
    }
  }
  pairs.sort((a, b) => a.pos - b.pos);
  return pairs.map((p) => p.word).join(" ").trim();
}

/**
 * Retry helper with exponential backoff for OpenAlex API calls.
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;
      const isTimeoutError =
        error.code === "ECONNABORTED" ||
        error.message?.includes("timeout") ||
        error.message?.includes("exceeded");

      if (isLastAttempt || !isTimeoutError) {
        throw error;
      }
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `OpenAlex request timeout, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Strip PubMed-style field tags so the query is suitable for OpenAlex full-text search.
 * e.g. "foo[tiab] OR bar[mh]" -> "foo OR bar"
 */
function toOpenAlexSearchQuery(pubmedStyleQuery) {
  if (!pubmedStyleQuery || typeof pubmedStyleQuery !== "string")
    return "";
  return pubmedStyleQuery
    .replace(/\s*\[[a-z A-Z0-9]+\]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Search OpenAlex works API and return items in the same shape as PubMed for merging.
 * @param {Object} opts
 * @param {string} opts.q - Search query (plain text or PubMed-style; tags will be stripped for OpenAlex)
 * @param {string} opts.mindate - YYYY/MM/DD or YYYY/MM
 * @param {string} opts.maxdate - YYYY/MM/DD or YYYY/MM
 * @param {number} opts.page - 1-based page
 * @param {number} opts.pageSize - Results per page (max 200 per OpenAlex docs)
 * @param {string} opts.sort - "relevance" | "date"
 * @returns {Promise<{ items: Array, totalCount: number, page: number, pageSize: number, hasMore: boolean }>}
 */
export async function searchOpenAlex({
  q = "",
  mindate = "",
  maxdate = "",
  page = 1,
  pageSize = 25,
  sort = "relevance",
} = {}) {
  const searchTerm = toOpenAlexSearchQuery(q || "").trim() || "medicine";
  const key = `oa:${searchTerm}:${mindate}:${maxdate}:${page}:${pageSize}:${sort}`;
  const cached = getCache(key);
  if (cached) return cached;

  try {
    const params = new URLSearchParams();
    params.set("search", searchTerm);
    params.set("per-page", String(Math.min(Number(pageSize) || 25, 200)));
    params.set("page", String(Math.max(1, Number(page) || 1)));
    if (sort === "date") {
      params.set("sort", "publication_date:desc");
    } else {
      params.set("sort", "relevance_score:desc");
    }

    // Date filter: from_publication_date, to_publication_date (YYYY-MM-DD)
    const filterParts = [];
    if (mindate) {
      let from = mindate.replace(/\//g, "-");
      if (from.length === 7) from += "-01";
      filterParts.push(`from_publication_date:${from}`);
    }
    if (maxdate) {
      let to = maxdate.replace(/\//g, "-");
      if (to.length === 7) {
        const [y, m] = to.split("-").map(Number);
        const lastDay = new Date(y, m, 0).getDate();
        to = `${to}-${String(lastDay).padStart(2, "0")}`;
      }
      filterParts.push(`to_publication_date:${to}`);
    }
    if (filterParts.length) params.set("filter", filterParts.join(","));

    const mailto = process.env.OPENALEX_MAILTO || "";
    const headers = {
      "User-Agent": "Mozilla/5.0 (compatible; CuraLink/1.0; mailto:" + (mailto || "support@curalink.org") + ")",
    };

    const url = `https://api.openalex.org/works?${params.toString()}`;
    const response = await retryWithBackoff(() =>
      axios.get(url, { timeout: 20000, headers }),
    );

    const data = response.data;
    const results = data.results || [];
    const totalCount = data.meta?.count ?? 0;

    const items = results.map((work) => {
      const doi = work.doi
        ? (work.doi.startsWith("http") ? work.doi : `https://doi.org/${work.doi}`)
        : "";
      const doiShort = work.doi
        ? (work.doi.replace(/^https?:\/\/doi\.org\//i, "") || work.doi)
        : "";
      const abstract = abstractFromInvertedIndex(work.abstract_inverted_index || {});

      const authors = (work.authorships || [])
        .map((a) => a.author?.display_name)
        .filter(Boolean);

      const journal =
        work.primary_location?.source?.display_name ||
        work.best_oa_location?.source?.display_name ||
        "";

      const pubDate = work.publication_date || "";
      const [pubYear = "", pubMonth = "", pubDay = ""] = pubDate.split("-");

      return {
        openalex_id: work.id ? work.id.replace("https://openalex.org/", "") : "",
        source: "openalex",
        pmid: undefined,
        title: work.title || work.display_name || "",
        journal,
        year: pubYear,
        month: pubMonth,
        day: pubDay,
        authors,
        doi: doiShort || doi,
        abstract,
        keywords: undefined,
        url: work.id || (doi ? `https://doi.org/${doiShort}` : ""),
        citationCount: work.cited_by_count ?? 0,
        rcr: null,
      };
    });

    const result = {
      items,
      totalCount,
      page: Number(page) || 1,
      pageSize: Number(pageSize) || 25,
      hasMore: (data.meta?.page ?? 1) * (data.meta?.per_page ?? 25) < totalCount,
    };
    setCache(key, result);
    return result;
  } catch (e) {
    if (
      e.code === "ECONNABORTED" ||
      e.response?.status === 429 ||
      e.message?.includes("timeout")
    ) {
      console.warn("OpenAlex fetch error (timeout/rate limit):", e.message);
    } else {
      console.warn("OpenAlex fetch error:", e.message);
    }
    return {
      items: [],
      totalCount: 0,
      page: 1,
      pageSize: 25,
      hasMore: false,
    };
  }
}

/**
 * Fetch all works by an author identified by ORCID (for profile publications).
 * Uses filter authorships.author.orcid. Returns array of works in profile-friendly shape:
 * { title, doi, pmid, openalexId, url, year, journal, authors, citedByCount, ... }
 * @param {string} orcid - ORCID ID (with or without https://orcid.org/ prefix)
 * @returns {Promise<Array<{ title: string, doi?: string, pmid?: string, openalexId: string, url: string, year?: string, journal?: string, authors: string[], citedByCount?: number }>>}
 */
export async function fetchAllWorksByOrcid(orcid) {
  if (!orcid || typeof orcid !== "string") return [];
  const raw = orcid.trim().replace(/\s+/g, "");
  const orcidUrl = raw.startsWith("http")
    ? raw
    : `https://orcid.org/${raw}`;

  const cacheKey = `oa-orcid:${orcidUrl}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const mailto = process.env.OPENALEX_MAILTO || "";
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; CuraLink/1.0; mailto:" +
      (mailto || "support@curalink.org") +
      ")",
  };

  const all = [];
  let page = 1;
  const perPage = 200;
  const maxPages = 10;

  try {
    while (page <= maxPages) {
      const params = new URLSearchParams({
        filter: `authorships.author.orcid:${encodeURIComponent(orcidUrl)}`,
        "per-page": String(perPage),
        page: String(page),
        sort: "publication_date:desc",
      });
      const url = `https://api.openalex.org/works?${params.toString()}`;
      const response = await retryWithBackoff(() =>
        axios.get(url, { timeout: 15000, headers }),
      );
      const data = response.data;
      const results = data.results || [];
      if (results.length === 0) break;

      for (const work of results) {
        const doiShort = work.doi
          ? work.doi.replace(/^https?:\/\/doi\.org\//i, "")
          : "";
        const doi = doiShort || (work.doi || "");
        const pmid = work.ids?.pmid || work.ids?.pmcid || null;
        const openalexId = work.id
          ? work.id.replace("https://openalex.org/", "")
          : "";
        const abstract = abstractFromInvertedIndex(
          work.abstract_inverted_index || {},
        );
        const authors = (work.authorships || []).map(
          (a) => a.author?.display_name,
        ).filter(Boolean);
        const journal =
          work.primary_location?.source?.display_name ||
          work.best_oa_location?.source?.display_name ||
          "";
        const pubDate = work.publication_date || "";
        const [pubYear = "", pubMonth = "", pubDay = ""] = pubDate.split("-");
        const link = work.id || (doi ? `https://doi.org/${doi}` : "");

        all.push({
          title: work.title || work.display_name || "",
          year: pubYear || null,
          month: pubMonth || null,
          day: pubDay || null,
          journal,
          journalTitle: journal,
          doi: doi || null,
          pmid: pmid || null,
          link,
          url: link,
          authors,
          openalexId: openalexId || null,
          id: pmid || doi || openalexId,
          citedByCount: work.cited_by_count ?? 0,
          abstract: abstract || undefined,
          source: "openalex",
        });
      }

      const total = data.meta?.count ?? 0;
      if (all.length >= total || results.length < perPage) break;
      page += 1;
    }

    setCache(cacheKey, all);
    return all;
  } catch (e) {
    console.warn("OpenAlex fetchAllWorksByOrcid error:", e?.message);
    return [];
  }
}

/**
 * Get a single work by OpenAlex ID (e.g. W2766808518) or DOI. For publication detail page.
 */
export async function getWorkById(openalexIdOrDoi) {
  const raw = (openalexIdOrDoi || "").trim();
  if (!raw) return null;

  const cacheKey = `oa-work:${raw}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const isDoi = /^10\.\d+\//.test(raw) || raw.startsWith("doi/");
  const id = isDoi ? `DOI:${raw.replace(/^doi\//i, "")}` : raw.replace(/^https?:\/\/openalex\.org\//i, "");
  const url = `https://api.openalex.org/works/${encodeURIComponent(id)}`;

  const mailto = process.env.OPENALEX_MAILTO || "";
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (compatible; CuraLink/1.0; mailto:" +
      (mailto || "support@curalink.org") +
      ")",
  };

  try {
    const response = await axios.get(url, { timeout: 10000, headers });
    const work = response.data;
    if (!work || !work.id) return null;

    const doiShort = work.doi
      ? work.doi.replace(/^https?:\/\/doi\.org\//i, "")
      : "";
    const pmid = work.ids?.pmid || work.ids?.pmcid || null;
    const openalexId = work.id.replace("https://openalex.org/", "");
    const abstract = abstractFromInvertedIndex(work.abstract_inverted_index || {});
    const authors = (work.authorships || []).map((a) => a.author?.display_name).filter(Boolean);
    const journal =
      work.primary_location?.source?.display_name ||
      work.best_oa_location?.source?.display_name ||
      "";
    const pubDate = work.publication_date || "";
    const [pubYear = "", pubMonth = "", pubDay = ""] = pubDate.split("-");
    const link = work.id || (doiShort ? `https://doi.org/${doiShort}` : "");

    const oaLocation = work.best_oa_location || work.primary_location;
    const pdfUrl = oaLocation?.is_oa ? oaLocation?.pdf_url || null : null;

    const out = {
      source: "openalex",
      openalex_id: openalexId,
      id: openalexId,
      pmid: pmid || undefined,
      doi: doiShort || work.doi,
      title: work.title || work.display_name || "",
      journal,
      year: pubYear,
      month: pubMonth,
      day: pubDay,
      authors,
      abstract,
      url: link,
      citationCount: work.cited_by_count ?? 0,
      pdfUrl: pdfUrl || null,
      open_access: work.primary_location?.is_oa ?? work.best_oa_location?.is_oa ?? null,
    };
    setCache(cacheKey, out);
    return out;
  } catch (e) {
    if (e.response?.status !== 404) console.warn("OpenAlex getWorkById error:", e?.message);
    return null;
  }
}
