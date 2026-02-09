import axios from "axios";

const OPENALEX_BASE = "https://api.openalex.org";

/**
 * Normalize ORCID ID to format OpenAlex expects (https://orcid.org/XXXX-XXXX-XXXX-XXXX)
 */
function normalizeOrcid(orcid) {
  if (!orcid || typeof orcid !== "string") return null;
  const cleaned = orcid.trim().replace(/\s+/g, "");
  if (!cleaned) return null;
  if (cleaned.startsWith("https://orcid.org/")) return cleaned;
  if (cleaned.startsWith("http://orcid.org/")) return cleaned.replace("http://", "https://");
  return `https://orcid.org/${cleaned}`;
}

/**
 * Fetch works from OpenAlex filtered by author ORCID (exact match only).
 * Uses authorships.author.orcid filter for precise matching.
 *
 * @param {string} orcidId - ORCID ID (e.g. 0000-0001-2345-6789 or https://orcid.org/0000-0001-2345-6789)
 * @param {object} options - { perPage: 200, cursor }
 * @returns {Promise<{ works: object[], meta: object }>}
 */
export async function fetchWorksByOrcid(orcidId, options = {}) {
  const { perPage = 200, cursor } = options;
  const orcid = normalizeOrcid(orcidId);
  if (!orcid) {
    return { works: [], meta: { count: 0 } };
  }

  try {
    const params = new URLSearchParams({
      filter: `authorships.author.orcid:${encodeURIComponent(orcid)}`,
      per_page: String(perPage),
    });
    if (cursor) params.set("cursor", cursor);

    const res = await axios.get(`${OPENALEX_BASE}/works?${params.toString()}`, {
      headers: { Accept: "application/json" },
      timeout: 15000,
    });

    const data = res.data;
    const results = data.results || [];
    const meta = data.meta || {};

    const works = results.map((w) => {
      const doi = w.doi ? w.doi.replace("https://doi.org/", "") : null;
      const pmid = w.ids?.pmid ? w.ids.pmid.replace("https://pubmed.ncbi.nlm.nih.gov/", "").replace(/\/?$/, "") : null;
      const link = w.doi
        ? `https://doi.org/${w.doi.replace("https://doi.org/", "")}`
        : pmid
          ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`
          : w.id || null;

      const authors = (w.authorships || []).map(
        (a) => a.author?.display_name || null
      ).filter(Boolean);

      return {
        title: w.title || "Untitled",
        year: w.publication_year || null,
        journal: w.primary_location?.source?.display_name || null,
        journalTitle: w.primary_location?.source?.display_name || null,
        doi,
        pmid,
        link,
        url: link,
        authors,
        type: w.type || null,
        openalexId: w.id ? w.id.replace("https://openalex.org/", "") : null,
        citedByCount: w.cited_by_count || 0,
        source: "openalex",
      };
    });

    return {
      works,
      meta: {
        count: meta.count || 0,
        nextCursor: meta.next_cursor || null,
      },
    };
  } catch (err) {
    console.error("OpenAlex fetch works by ORCID error:", err.message);
    if (err.response) {
      console.error("OpenAlex response:", err.response.status, err.response.data);
    }
    return { works: [], meta: { count: 0 } };
  }
}

/**
 * Fetch ALL works for an ORCID (paginates through OpenAlex cursor if needed).
 */
export async function fetchAllWorksByOrcid(orcidId, maxWorks = 500) {
  const allWorks = [];
  let cursor = null;
  const seen = new Set();

  do {
    const { works, meta } = await fetchWorksByOrcid(orcidId, {
      perPage: 200,
      cursor,
    });

    for (const w of works) {
      const key = w.openalexId || w.doi || w.pmid || w.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        allWorks.push(w);
      }
    }

    cursor = meta.nextCursor;
    if (!cursor || allWorks.length >= maxWorks) break;
  } while (true);

  return allWorks.slice(0, maxWorks);
}
