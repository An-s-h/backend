/**
 * Unified publication search: PubMed, OpenAlex, Semantic Scholar, Crossref, arXiv.
 * Multi-source aggregation for Scholar-like coverage; results deduplicated and ranked.
 */

import { searchPubMed } from "./pubmed.service.js";
import { searchOpenAlex } from "./openalex.service.js";
import { searchSemanticScholar } from "./semanticScholar.service.js";
import { searchArxiv } from "./arxiv.service.js";

/** Normalize DOI for deduplication (lowercase, no URL prefix). */
function normalizeDoi(doi) {
  if (!doi || typeof doi !== "string") return "";
  return doi
    .toLowerCase()
    .replace(/^https?:\/\/doi\.org\//i, "")
    .trim();
}

/** Normalize title for deduplication (lowercase, collapse spaces). */
function normalizeTitle(title) {
  if (!title || typeof title !== "string") return "";
  return title.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Deduplicate publications: prefer DOI match, then normalized title match.
 * When duplicate: keep PubMed version when both have same DOI/title so we retain MeSH, PMID, etc.
 */
function deduplicate(items) {
  const seenByDoi = new Map();
  const seenByTitle = new Map();
  const out = [];

  for (const pub of items) {
    const doi = normalizeDoi(pub.doi);
    const title = normalizeTitle(pub.title);
    if (!title) continue;

    if (doi && seenByDoi.has(doi)) continue;
    if (seenByTitle.has(title)) continue;

    if (doi) seenByDoi.set(doi, true);
    seenByTitle.set(title, true);
    out.push(pub);
  }
  return out;
}

/**
 * Combined publication search: PubMed + OpenAlex.
 * Same options as searchPubMed; results from both sources are merged and deduplicated.
 *
 * @param {Object} opts - Same as searchPubMed: q, mindate, maxdate, page, pageSize, sort, skipParsing
 * @param {number} [opts.pubmedBatchSize] - Max items to request from PubMed (default: same as pageSize when single page, else 300)
 * @param {number} [opts.openalexBatchSize] - Max items to request from OpenAlex (default: same)
 * @returns {Promise<{ items: Array, totalCount: number, page: number, pageSize: number, hasMore: boolean, sourcesUsed: string[] }>}
 */
export async function searchPublications({
  q = "",
  mindate = "",
  maxdate = "",
  page = 1,
  pageSize = 9,
  sort = "relevance",
  skipParsing = false,
  pubmedBatchSize,
  openalexBatchSize,
} = {}) {
  const batch = Math.max(
    Number(pubmedBatchSize) || Math.max(pageSize, 300),
    Number(openalexBatchSize) || Math.max(pageSize, 300),
  );

  const [pubmedSettled, openalexSettled] = await Promise.allSettled([
    searchPubMed({
      q,
      mindate,
      maxdate,
      page: 1,
      pageSize: batch,
      sort,
      skipParsing,
    }),
    searchOpenAlex({
      q,
      mindate,
      maxdate,
      page: 1,
      pageSize: batch,
      sort,
    }),
  ]);

  const pubmedResult =
    pubmedSettled.status === "fulfilled" ? pubmedSettled.value : null;
  const openalexResult =
    openalexSettled.status === "fulfilled" ? openalexSettled.value : null;

  if (pubmedSettled.status === "rejected") {
    console.warn("PubMed search failed in combined search:", pubmedSettled.reason?.message);
  }
  if (openalexSettled.status === "rejected") {
    console.warn("OpenAlex search failed in combined search:", openalexSettled.reason?.message);
  }

  const pubmedItems = pubmedResult?.items || [];
  const openalexItems = openalexResult?.items || [];

  // Ensure each item has a stable id for downstream (pmid or openalex_id)
  const withId = (p) => ({
    ...p,
    id: p.pmid || p.openalex_id || p.id || "",
  });
  const combined = [
    ...pubmedItems.map(withId),
    ...openalexItems.map(withId),
  ];

  // Sort by citation count (desc) then year (desc) then keep order
  combined.sort((a, b) => {
    const citeA = a.citationCount ?? a.cited_by_count ?? 0;
    const citeB = b.citationCount ?? b.cited_by_count ?? 0;
    if (citeB !== citeA) return citeB - citeA;
    const yearA = parseInt(a.year, 10) || 0;
    const yearB = parseInt(b.year, 10) || 0;
    return yearB - yearA;
  });

  const merged = deduplicate(combined);
  const totalCount =
    (pubmedResult?.totalCount ?? 0) + (openalexResult?.totalCount ?? 0);
  const sourcesUsed = [];
  if (pubmedResult && (pubmedResult?.items?.length || 0) > 0) sourcesUsed.push("pubmed");
  if (openalexResult && (openalexResult?.items?.length || 0) > 0) sourcesUsed.push("openalex");

  // In-memory pagination for merged list
  const start = (page - 1) * pageSize;
  const paginatedItems = merged.slice(start, start + pageSize);

  return {
    items: paginatedItems,
    totalCount: merged.length,
    page,
    pageSize,
    hasMore: start + paginatedItems.length < merged.length,
    sourcesUsed,
    _meta: {
      pubmedTotal: pubmedResult?.totalCount ?? 0,
      openalexTotal: openalexResult?.totalCount ?? 0,
      mergedCount: merged.length,
    },
  };
}

/** Strip PubMed-style field tags for plain-query sources (Semantic Scholar, Crossref, arXiv). */
function plainQuery(q) {
  if (!q || typeof q !== "string") return "";
  return q.replace(/\s*\[[a-z A-Z0-9]+\]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Combined search that returns a single large batch (no pagination), for use by the search route.
 * Sources: PubMed, OpenAlex, Semantic Scholar, Crossref, arXiv (optional via env).
 *
 * @param {Object} opts - q, mindate, maxdate, sort, skipParsing, batchSize
 * @returns {Promise<{ items: Array, totalCount: number, sourcesUsed: string[], sourceCounts: Object }>}
 */
export async function searchPublicationsBatch({
  q = "",
  mindate = "",
  maxdate = "",
  sort = "relevance",
  skipParsing = false,
  batchSize = 300,
} = {}) {
  const plain = plainQuery(q);
  const useExtraSources =
    process.env.SEMANTIC_SCHOLAR_ENABLED !== "false" &&
    process.env.ARXIV_ENABLED !== "false";

  const perPrimary = Math.max(1, Math.floor(Number(batchSize) / 2));
  const perExtra = Math.max(20, Math.min(50, Math.floor(Number(batchSize) / 6)));

  const promises = [
    searchPubMed({
      q,
      mindate,
      maxdate,
      page: 1,
      pageSize: perPrimary,
      sort,
      skipParsing,
    }),
    searchOpenAlex({
      q,
      mindate,
      maxdate,
      page: 1,
      pageSize: perPrimary,
      sort,
    }),
  ];
  if (useExtraSources && plain) {
    promises.push(
      searchSemanticScholar({ q: plain, page: 1, pageSize: perExtra }),
      searchArxiv({ q: plain, page: 1, pageSize: perExtra }),
    );
  }

  const settled = await Promise.allSettled(promises);

  const pubmedResult = settled[0].status === "fulfilled" ? settled[0].value : null;
  const openalexResult = settled[1].status === "fulfilled" ? settled[1].value : null;
  const ssResult = useExtraSources && settled[2]?.status === "fulfilled" ? settled[2].value : null;
  const arxivResult = useExtraSources && settled[3]?.status === "fulfilled" ? settled[3].value : null;

  [settled[0], settled[1]].forEach((s, i) => {
    if (s.status === "rejected")
      console.warn(["PubMed", "OpenAlex"][i], "search failed:", s.reason?.message);
  });

  const tag = (p, src) => ({
    ...p,
    id: p.pmid || p.openalex_id || p.semantic_scholar_id || p.arxiv_id || p.id || "",
    source: p.source || src,
  });

  const combined = [
    ...(pubmedResult?.items || []).map((p) => tag(p, "pubmed")),
    ...(openalexResult?.items || []).map((p) => tag(p, "openalex")),
    ...(ssResult?.items || []).map((p) => tag(p, "semantic_scholar")),
    ...(arxivResult?.items || []).map((p) => tag(p, "arxiv")),
  ];

  combined.sort((a, b) => {
    const citeA = a.citationCount ?? a.cited_by_count ?? 0;
    const citeB = b.citationCount ?? b.cited_by_count ?? 0;
    if (citeB !== citeA) return citeB - citeA;
    const infA = a.influentialCitationCount ?? 0;
    const infB = b.influentialCitationCount ?? 0;
    if (infB !== infA) return infB - infA;
    const yearA = parseInt(a.year, 10) || 0;
    const yearB = parseInt(b.year, 10) || 0;
    return yearB - yearA;
  });

  const merged = deduplicate(combined);
  const sourcesUsed = [];
  if (pubmedResult?.items?.length) sourcesUsed.push("pubmed");
  if (openalexResult?.items?.length) sourcesUsed.push("openalex");
  if (ssResult?.items?.length) sourcesUsed.push("semantic_scholar");
  if (arxivResult?.items?.length) sourcesUsed.push("arxiv");

  const sourceCounts = {
    pubmed: merged.filter((p) => p.source === "pubmed").length,
    openalex: merged.filter((p) => p.source === "openalex").length,
    semantic_scholar: merged.filter((p) => p.source === "semantic_scholar").length,
    arxiv: merged.filter((p) => p.source === "arxiv").length,
  };

  return {
    items: merged,
    totalCount:
      (pubmedResult?.totalCount ?? 0) +
      (openalexResult?.totalCount ?? 0) +
      (ssResult?.totalCount ?? 0) +
      (arxivResult?.totalCount ?? 0),
    sourcesUsed,
    sourceCounts,
  };
}
