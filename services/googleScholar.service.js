import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

// OpenAlex API is free and doesn't require authentication
// Adding email provides higher rate limits (100,000/day vs 10,000/day)
const OPENALEX_EMAIL = process.env.OPENALEX_EMAIL || "user@example.com";
const OPENALEX_BASE_URL = "https://api.openalex.org";

// Cache for author IDs to reduce API calls
const authorIdCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache

function getCacheKey(authorName) {
  return `openalex:author:${authorName.toLowerCase().trim()}`;
}

function getCache(key) {
  const item = authorIdCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    authorIdCache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  authorIdCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });

  // Cleanup old cache entries if cache gets too large
  if (authorIdCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of authorIdCache.entries()) {
      if (now > v.expires) {
        authorIdCache.delete(k);
      }
    }
  }
}

/**
 * Search for an author in OpenAlex by name
 * @param {string} authorName - Author name to search for
 * @returns {Promise<Object|null>} Author object with id, name, and metadata
 */
async function findAuthorInOpenAlex(authorName) {
  if (!authorName || !authorName.trim()) {
    return null;
  }

  // Check cache first
  const cacheKey = getCacheKey(authorName);
  const cached = getCache(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // Search for author by display name
    const response = await axios.get(`${OPENALEX_BASE_URL}/authors`, {
      params: {
        search: authorName.trim(),
        per_page: 5, // Get top 5 matches to find best match
        mailto: OPENALEX_EMAIL,
      },
      timeout: 15000,
    });

    const authors = response.data?.results || [];
    if (authors.length === 0) {
      return null;
    }

    // Find the best matching author (highest works count among close name matches)
    const normalizedSearchName = authorName.toLowerCase().trim();
    let bestMatch = null;
    let bestScore = -1;

    for (const author of authors) {
      const displayName = (author.display_name || "").toLowerCase();
      
      // Calculate a simple matching score
      let score = 0;
      
      // Exact match bonus
      if (displayName === normalizedSearchName) {
        score += 1000;
      }
      
      // Partial match (name contains search or vice versa)
      if (displayName.includes(normalizedSearchName) || normalizedSearchName.includes(displayName)) {
        score += 100;
      }
      
      // Add works count as tiebreaker (prefer more prolific authors)
      score += (author.works_count || 0) / 100;
      
      // Add citation count as another factor
      score += (author.cited_by_count || 0) / 10000;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = author;
      }
    }

    if (bestMatch) {
      const authorData = {
        id: bestMatch.id,
        openAlexId: bestMatch.id?.replace("https://openalex.org/", ""),
        displayName: bestMatch.display_name,
        worksCount: bestMatch.works_count || 0,
        citedByCount: bestMatch.cited_by_count || 0,
        lastKnownInstitution: bestMatch.last_known_institution?.display_name || null,
      };

      // Cache the result
      setCache(cacheKey, authorData);
      return authorData;
    }

    return null;
  } catch (error) {
    console.error("Error searching OpenAlex for author:", error.message);
    return null;
  }
}

/**
 * Fetch publications for an author from OpenAlex
 * @param {string} authorId - OpenAlex author ID (e.g., "A123456789" or full URL)
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of publication objects
 */
async function fetchAuthorPublications(authorId, limit = 10) {
  if (!authorId) {
    return [];
  }

  try {
    // Extract just the short ID if it's a full URL (e.g., "https://openalex.org/A123" -> "A123")
    const shortId = authorId.replace("https://openalex.org/", "");

    // Use the works endpoint with filter by author ID
    // The filter format is: filter=author.id:A123456789
    const response = await axios.get(`${OPENALEX_BASE_URL}/works`, {
      params: {
        filter: `author.id:${shortId}`,
        sort: "cited_by_count:desc", // Sort by citations (most cited first)
        per_page: Math.min(Math.max(1, limit), 50), // Clamp between 1 and 50
        mailto: OPENALEX_EMAIL,
      },
      timeout: 15000,
    });

    const works = response.data?.results || [];

    return works.map((work) => {
      // Get the DOI URL or best available link
      let link = work.doi || work.id;
      if (work.doi && !work.doi.startsWith("http")) {
        link = `https://doi.org/${work.doi}`;
      }
      
      // Try to get open access PDF link if available
      let pdfLink = null;
      if (work.open_access?.oa_url) {
        pdfLink = work.open_access.oa_url;
      } else if (work.primary_location?.pdf_url) {
        pdfLink = work.primary_location.pdf_url;
      }

      // Get authors list
      const authors = (work.authorships || [])
        .slice(0, 5) // Limit to first 5 authors
        .map((authorship) => authorship.author?.display_name)
        .filter(Boolean);

      // Get venue/journal name
      const venue = work.primary_location?.source?.display_name ||
        work.host_venue?.display_name ||
        "";

      // Build abstract from inverted index if available
      let abstract = "";
      if (work.abstract_inverted_index) {
        try {
          // OpenAlex stores abstracts as inverted indexes - reconstruct it
          const invertedIndex = work.abstract_inverted_index;
          const wordPositions = [];
          for (const [word, positions] of Object.entries(invertedIndex)) {
            for (const pos of positions) {
              wordPositions.push({ word, pos });
            }
          }
          wordPositions.sort((a, b) => a.pos - b.pos);
          abstract = wordPositions.map((wp) => wp.word).join(" ");
          // Truncate if too long
          if (abstract.length > 500) {
            abstract = abstract.substring(0, 500) + "...";
          }
        } catch (e) {
          // If reconstruction fails, leave abstract empty
        }
      }

      return {
        title: work.title || "Untitled",
        link: link,
        snippet: abstract || work.title || "",
        abstract: abstract,
        authors: authors,
        publication: venue,
        year: work.publication_year || null,
        citations: work.cited_by_count || 0,
        pdfLink: pdfLink,
        openAccess: work.open_access?.is_oa || false,
        type: work.type || "unknown",
        doi: work.doi || null,
      };
    });
  } catch (error) {
    console.error("Error fetching publications from OpenAlex:", error.message);
    return [];
  }
}

/**
 * Search Semantic Scholar for publications by author name (fallback)
 * @param {string} authorName - Author name to search for
 * @param {number} limit - Maximum number of results
 * @returns {Promise<Array>} Array of publication objects
 */
async function searchSemanticScholar(authorName, limit = 10) {
  try {
    // First, search for the author
    const authorSearchResponse = await axios.get(
      "https://api.semanticscholar.org/graph/v1/author/search",
      {
        params: {
          query: authorName,
          limit: 5, // Get top 5 matching authors
          fields: "authorId,name",
        },
        timeout: 10000,
      }
    );

    const authors = authorSearchResponse.data?.data || [];
    if (authors.length === 0) {
      return [];
    }

    // Use the first matching author (most relevant)
    const authorId = authors[0].authorId;

    // Get publications for this author
    const publicationsResponse = await axios.get(
      `https://api.semanticscholar.org/graph/v1/author/${authorId}/papers`,
      {
        params: {
          fields: "title,url,abstract,year,citationCount,authors,venue",
          limit: limit,
          sort: "citationCount:desc", // Sort by citations
        },
        timeout: 10000,
      }
    );

    const papers = publicationsResponse.data?.data || [];

    return papers.map((paper) => ({
      title: paper.title || "Untitled",
      link: paper.url || null,
      snippet: paper.abstract || "", // Use abstract as snippet
      abstract: paper.abstract || "", // Also store as abstract for full text
      authors: paper.authors?.map((a) => a.name) || [],
      publication: paper.venue || "",
      year: paper.year || null,
      citations: paper.citationCount || 0,
      pdfLink: null, // Semantic Scholar doesn't provide direct PDF links in this endpoint
    }));
  } catch (error) {
    console.error("Error searching Semantic Scholar:", error.message);
    return [];
  }
}

/**
 * Search for publications by a specific researcher using OpenAlex API
 * Falls back to Semantic Scholar if OpenAlex returns no results
 * @param {Object} params - Search parameters
 * @param {string} params.author - Author name to search for
 * @param {number} params.num - Number of results (1-50, default 10)
 * @returns {Promise<Array>} Array of publication objects
 */
export async function searchGoogleScholarPublications({
  author = "",
  num = 10,
} = {}) {
  if (!author || !author.trim()) {
    return [];
  }

  let publications = [];

  // Try OpenAlex first (primary source)
  try {
    console.log(`Searching OpenAlex for publications by "${author}"...`);
    
    // First find the author
    const authorData = await findAuthorInOpenAlex(author);
    
    if (authorData && authorData.id) {
      console.log(`Found author in OpenAlex: ${authorData.displayName} (${authorData.worksCount} works, ${authorData.citedByCount} citations)`);
      
      // Fetch their publications
      publications = await fetchAuthorPublications(authorData.id, num);
      
      if (publications.length > 0) {
        console.log(`Found ${publications.length} publications from OpenAlex`);
        return publications;
      }
    } else {
      console.log(`Author "${author}" not found in OpenAlex, trying fallback...`);
    }
  } catch (error) {
    console.error("Error with OpenAlex:", error.message);
  }

  // Fallback to Semantic Scholar if no results from OpenAlex
  if (publications.length === 0) {
    console.log(
      `No results from OpenAlex for "${author}", trying Semantic Scholar...`
    );
    try {
      const semanticResults = await searchSemanticScholar(author, num);
      if (semanticResults.length > 0) {
        console.log(
          `Found ${semanticResults.length} publications from Semantic Scholar`
        );
        return semanticResults;
      }
    } catch (error) {
      console.error("Error with Semantic Scholar fallback:", error.message);
    }
  }

  return publications;
}

/**
 * Search OpenAlex for publications by a general query (not author-specific)
 * @param {Object} params - Search parameters
 * @param {string} params.q - Search query
 * @param {number} params.num - Number of results (1-50, default 10)
 * @returns {Promise<Array>} Array of publication objects
 */
export async function searchGoogleScholar({ q = "", num = 10 } = {}) {
  if (!q || !q.trim()) {
    return [];
  }

  try {
    const response = await axios.get(`${OPENALEX_BASE_URL}/works`, {
      params: {
        search: q.trim(),
        sort: "cited_by_count:desc", // Sort by citations
        per_page: Math.min(Math.max(1, num), 50),
        mailto: OPENALEX_EMAIL,
      },
      timeout: 15000,
    });

    const works = response.data?.results || [];

    return works.map((work) => {
      // Get the DOI URL or best available link
      let link = work.doi || work.id;
      if (work.doi && !work.doi.startsWith("http")) {
        link = `https://doi.org/${work.doi}`;
      }

      // Get authors list
      const authors = (work.authorships || [])
        .slice(0, 5)
        .map((authorship) => authorship.author?.display_name)
        .filter(Boolean);

      // Get venue/journal name
      const venue = work.primary_location?.source?.display_name ||
        work.host_venue?.display_name ||
        "";

      // Build abstract from inverted index if available
      let abstract = "";
      if (work.abstract_inverted_index) {
        try {
          const invertedIndex = work.abstract_inverted_index;
          const wordPositions = [];
          for (const [word, positions] of Object.entries(invertedIndex)) {
            for (const pos of positions) {
              wordPositions.push({ word, pos });
            }
          }
          wordPositions.sort((a, b) => a.pos - b.pos);
          abstract = wordPositions.map((wp) => wp.word).join(" ");
          if (abstract.length > 500) {
            abstract = abstract.substring(0, 500) + "...";
          }
        } catch (e) {
          // If reconstruction fails, leave abstract empty
        }
      }

      return {
        title: work.title || "Untitled",
        link: link,
        snippet: abstract || work.title || "",
        abstract: abstract,
        authors: authors,
        publication: venue,
        year: work.publication_year || null,
        citations: work.cited_by_count || 0,
        pdfLink: work.open_access?.oa_url || work.primary_location?.pdf_url || null,
      };
    });
  } catch (error) {
    console.error("Error searching OpenAlex:", error.message);
    return [];
  }
}
