/**
 * arXiv API – preprints (physics, CS, math, etc.).
 * @see https://info.arxiv.org/help/api/user-manual.html
 * Query: use all:term1 AND all:term2 to require all terms (avoids e.g. "Alzheimer's disease" for "asthma heart disease").
 */

import axios from "axios";
import { DOMParser } from "xmldom";

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

/** Build search_query per API: all:term1 AND all:term2 so results must contain all concepts. */
function buildSearchQuery(query) {
  const safe = (query || "").trim().replace(/\s+/g, " ").replace(/"/g, "");
  if (!safe) return "";
  const terms = safe.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length <= 1) return `all:${safe}`;
  return terms.map((t) => `all:${t}`).join(" AND ");
}

/**
 * Search arXiv. Returns items in common publication shape.
 */
export async function searchArxiv({ q = "", page = 1, pageSize = 25 } = {}) {
  const query = (q || "").trim().replace(/\s+/g, " ");
  if (!query)
    return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };

  const searchQuery = buildSearchQuery(query);
  const key = `arxiv:${searchQuery}:${page}:${pageSize}`;
  const cached = getCached(key);
  if (cached) return cached;

  const maxResults = Math.min(Number(pageSize) || 25, 100);
  const start = (Math.max(1, Number(page)) - 1) * maxResults;

  try {
    const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(
      searchQuery,
    )}&start=${start}&max_results=${maxResults}&sortBy=relevance`;
    const res = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(res.data, "text/xml");
    const entries = Array.from(doc.getElementsByTagName("entry"));

    const items = entries.map((entry) => {
      const idEl = entry.getElementsByTagName("id")[0];
      const idUrl = idEl?.textContent || "";
      const arxivId =
        idUrl.split("/abs/")[1] || idUrl.split("arxiv.org/abs/")[1] || "";
      const title = (entry.getElementsByTagName("title")[0]?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const summary = (
        entry.getElementsByTagName("summary")[0]?.textContent || ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const authors = Array.from(entry.getElementsByTagName("author"))
        .map((a) =>
          (a.getElementsByTagName("name")[0]?.textContent || "").trim(),
        )
        .filter(Boolean);
      const published =
        entry.getElementsByTagName("published")[0]?.textContent || "";
      const year = published ? published.slice(0, 4) : "";
      const linkEls = entry.getElementsByTagName("link");
      let pdfUrl = "";
      let absUrl = idUrl;
      for (let i = 0; i < linkEls.length; i++) {
        const rel =
          linkEls[i].getAttribute("title") || linkEls[i].getAttribute("rel");
        const href = linkEls[i].getAttribute("href") || "";
        if (rel === "pdf" || href.includes("/pdf/")) pdfUrl = href;
        if (href.includes("/abs/")) absUrl = href;
      }

      return {
        source: "arxiv",
        arxiv_id: arxivId,
        id: arxivId || `arxiv:${arxivId}`,
        title,
        journal: "arXiv",
        year,
        authors,
        abstract: summary,
        url: absUrl,
        pdfUrl:
          pdfUrl || (arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : ""),
        citationCount: null,
      };
    });

    const total =
      items.length < maxResults ? start + items.length : start + maxResults + 1;
    const result = {
      items,
      totalCount: total,
      page: Number(page) || 1,
      pageSize: maxResults,
      hasMore: items.length === maxResults,
    };
    setCache(key, result);
    return result;
  } catch (err) {
    console.warn("arXiv search error:", err?.message);
    return { items: [], totalCount: 0, page: 1, pageSize: 25, hasMore: false };
  }
}

/**
 * Get a single arXiv preprint by ID (e.g. 2103.12345 or cs/0102001). For detail page.
 */
export async function getArxivById(arxivId) {
  const id = (arxivId || "").trim().replace(/^arxiv\//i, "");
  if (!id) return null;

  const key = `arxiv-get:${id}`;
  const cached = getCached(key);
  if (cached) return cached;

  try {
    const url = `https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}`;
    const res = await axios.get(url, {
      timeout: 10000,
      headers: { "User-Agent": "CuraLink/1.0 (mailto:support@curalink.org)" },
    });

    const parser = new DOMParser();
    const doc = parser.parseFromString(res.data, "text/xml");
    const entry = doc.getElementsByTagName("entry")[0];
    if (!entry) return null;

    const idEl = entry.getElementsByTagName("id")[0];
    const idUrl = idEl?.textContent || "";
    const title = (entry.getElementsByTagName("title")[0]?.textContent || "")
      .replace(/\s+/g, " ")
      .trim();
    const summary = (
      entry.getElementsByTagName("summary")[0]?.textContent || ""
    )
      .replace(/\s+/g, " ")
      .trim();
    const authors = Array.from(entry.getElementsByTagName("author"))
      .map((a) => (a.getElementsByTagName("name")[0]?.textContent || "").trim())
      .filter(Boolean);
    const published =
      entry.getElementsByTagName("published")[0]?.textContent || "";
    const year = published ? published.slice(0, 4) : "";
    const linkEls = entry.getElementsByTagName("link");
    let pdfUrl = "";
    let absUrl = idUrl;
    for (let i = 0; i < linkEls.length; i++) {
      const href = linkEls[i].getAttribute("href") || "";
      if (href.includes("/pdf/")) pdfUrl = href;
      if (href.includes("/abs/")) absUrl = href;
    }

    const out = {
      source: "arxiv",
      arxiv_id: id,
      id,
      title,
      journal: "arXiv",
      year,
      authors,
      abstract: summary,
      url: absUrl,
      pdfUrl: pdfUrl || `https://arxiv.org/pdf/${id}.pdf`,
    };
    setCache(key, out);
    return out;
  } catch (err) {
    console.warn("arXiv get error:", err?.message);
    return null;
  }
}
