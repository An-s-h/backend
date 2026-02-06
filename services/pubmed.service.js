import axios from "axios";
import { DOMParser } from "xmldom";
import {
  parseQuery,
  hasDateFilter,
  extractDateRangeFromQuery,
  removeDateFilterFromQuery,
} from "../utils/queryParser.js";

const cache = new Map();
const TTL_MS = 1000 * 60 * 5;

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
 * Retry helper with exponential backoff for PubMed API calls
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

      // Exponential backoff: 1s, 2s, 4s
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `PubMed request timeout, retrying in ${delay}ms... (attempt ${
          attempt + 1
        }/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function searchPubMed({
  q = "",
  mindate = "",
  maxdate = "",
  page = 1,
  pageSize = 9,
  sort = "relevance", // "relevance" | "date" - use "date" for recent/latest
} = {}) {
  // Build cache key with all parameters
  const key = `pm:${q}:${mindate}:${maxdate}:${page}:${pageSize}:${sort}`;
  const cached = getCache(key);
  if (cached) return cached;

  try {
    // Step 1: Get PMIDs with retry logic and increased timeout
    const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;

    // Parse query to handle Google Scholar operators and minus sign NOT
    let searchTerm = q ? parseQuery(q) : "";

    // Check if query already contains date filter [dp] tag
    const queryHasDateFilter = hasDateFilter(searchTerm);

    // Build date filter if provided and not already in query
    if (!queryHasDateFilter && (mindate || maxdate)) {
      // PubMed date format: YYYY/MM/DD
      // If only YYYY/MM is provided, add day component
      let dateMin = mindate || "1900/01/01";
      let dateMax =
        maxdate || new Date().toISOString().split("T")[0].replace(/-/g, "/");

      // Ensure proper format - add day if only year/month provided
      // mindate should start from first day of month
      if (dateMin && dateMin.split("/").length === 2) {
        dateMin = `${dateMin}/01`;
      }
      // maxdate should end at last day of month
      if (dateMax && dateMax.split("/").length === 2) {
        // Get last day of the month
        const [year, month] = dateMax.split("/");
        const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
        dateMax = `${dateMax}/${lastDay}`;
      }

      // PubMed date filter syntax - correct format is: YYYY/MM/DD:YYYY/MM/DD[dp]
      // Using [dp] (Date of Publication) which is the standard PubMed date field
      const dateFilter = `${dateMin}:${dateMax}[dp]`;

      if (searchTerm) {
        // Combine search term with date filter
        searchTerm = `(${searchTerm}) AND (${dateFilter})`;
      } else {
        // Use only date filter - this will return all publications in the date range
        searchTerm = dateFilter;
      }
    } else if (queryHasDateFilter) {
      // Query already has date filter, but we might need to merge with provided dates
      // For now, we'll use the date filter from the query
      // In the future, we could extract and merge date ranges
      const extractedDate = extractDateRangeFromQuery(searchTerm);
      if (extractedDate && (mindate || maxdate)) {
        // Merge date ranges - use the more restrictive range
        // This is a simple implementation - could be enhanced
        console.log(
          "Query contains date filter, using query date filter over parameters"
        );
      }
    }

    // If still no search term, use a default
    if (!searchTerm) {
      searchTerm = "oncology";
    }

    console.log("PubMed search term (parsed):", searchTerm);

    // Calculate pagination offset
    const retstart = (page - 1) * pageSize;

    const esearchParams = new URLSearchParams({
      db: "pubmed",
      term: searchTerm,
      retmode: "json",
      retmax: String(Math.min(Number(pageSize), 500)), // PubMed allows up to 10k; we cap at 500 for performance
      retstart: String(retstart),
      sort: sort === "date" ? "date" : "relevance", // "date" for newest first, "relevance" for relevance
    });

    const idsResp = await retryWithBackoff(async () => {
      return await axios.get(`${esearchUrl}?${esearchParams}`, {
        timeout: 20000, // Increased from 10000 to 20000ms
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CuraLink/1.0)",
        },
      });
    });

    const ids = idsResp.data?.esearchresult?.idlist || [];
    const totalCount = parseInt(idsResp.data?.esearchresult?.count || "0", 10);

    if (ids.length === 0) return { items: [], totalCount: 0, page, pageSize };

    // Step 2: Fetch detailed metadata with EFetch with retry logic and increased timeout
    // Use POST to avoid 414 URI Too Long when fetching many PMIDs (GET URL has ~9 chars per ID)
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const efetchParams = new URLSearchParams({
      db: "pubmed",
      id: ids.join(","),
      retmode: "xml",
    });

    const xmlResp = await retryWithBackoff(async () => {
      return await axios.post(efetchUrl, efetchParams.toString(), {
        timeout: 30000,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; CuraLink/1.0)",
          "Content-Type": "application/x-www-form-urlencoded",
        },
      });
    });

    // Step 3: Parse XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlResp.data, "text/xml");
    const articles = Array.from(xmlDoc.getElementsByTagName("PubmedArticle"));

    const items = articles.map((article) => {
      const getText = (tag) =>
        article.getElementsByTagName(tag)[0]?.textContent || "";
      const getAllText = (tag) =>
        Array.from(article.getElementsByTagName(tag)).map(
          (el) => el.textContent || ""
        );

      const pmid = getText("PMID");
      const title = getText("ArticleTitle");

      // Get full abstract - concatenate all AbstractText elements (structured abstracts have multiple sections)
      const abstractElements = article.getElementsByTagName("AbstractText");
      let abstract = "";
      if (abstractElements.length > 0) {
        // If there's a Label attribute (structured abstract), include it
        const abstractParts = Array.from(abstractElements).map((el) => {
          const label = el.getAttribute("Label");
          const text = el.textContent || "";
          return label ? `${label}: ${text}` : text;
        });
        abstract = abstractParts.join("\n\n");
      }

      const journal = getText("Title");
      const pubDateNode = article.getElementsByTagName("PubDate")[0];
      const pubYear =
        pubDateNode?.getElementsByTagName("Year")[0]?.textContent || "";
      const pubMonth =
        pubDateNode?.getElementsByTagName("Month")[0]?.textContent || "";
      const pubDay =
        pubDateNode?.getElementsByTagName("Day")[0]?.textContent || "";

      // Get DOI - check multiple possible locations
      let doi = "";
      const eLocationIds = article.getElementsByTagName("ELocationID");
      for (let i = 0; i < eLocationIds.length; i++) {
        const eidType = eLocationIds[i].getAttribute("EIdType");
        if (eidType === "doi") {
          doi = eLocationIds[i].textContent || "";
          break;
        }
      }
      // Fallback to first ELocationID if no DOI found
      if (!doi && eLocationIds.length > 0) {
        doi = eLocationIds[0].textContent || "";
      }

      // Get authors with affiliations
      const authors = Array.from(article.getElementsByTagName("Author"))
        .map((a) => {
          const last = a.getElementsByTagName("LastName")[0]?.textContent || "";
          const fore = a.getElementsByTagName("ForeName")[0]?.textContent || "";
          const initials =
            a.getElementsByTagName("Initials")[0]?.textContent || "";
          return `${fore} ${last}`.trim() || `${initials} ${last}`.trim();
        })
        .filter(Boolean);

      // Get keywords
      const keywords = getAllText("Keyword").filter(Boolean);

      // Get publication type
      const publicationTypes = Array.from(
        article.getElementsByTagName("PublicationType")
      )
        .map((type) => type.textContent || "")
        .filter(Boolean);

      // Get country
      const country = getText("Country");

      // Get affiliation (first author's affiliation if available)
      const affiliations = Array.from(
        article.getElementsByTagName("Affiliation")
      )
        .map((aff) => aff.textContent || "")
        .filter(Boolean);

      // Return cleaned publication data (removed: MeSH terms, ISBN, publisher, book, volume, pagination, language)
      return {
        pmid,
        title,
        journal,
        year: pubYear,
        month: pubMonth,
        day: pubDay,
        authors,
        doi,
        abstract,
        keywords: keywords.length > 0 ? keywords : undefined,
        publicationTypes:
          publicationTypes.length > 0 ? publicationTypes : undefined,
        country: country || undefined,
        affiliations: affiliations.length > 0 ? affiliations : undefined,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      };
    });

    const result = {
      items,
      totalCount,
      page,
      pageSize,
      hasMore: page * pageSize < totalCount,
    };
    setCache(key, result);
    return result;
  } catch (e) {
    // More detailed error logging
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      console.error(
        "PubMed fetch error: timeout exceeded after retries",
        e.message
      );
    } else {
      console.error("PubMed fetch error:", e.message);
    }
    // Return empty result instead of throwing to prevent cascading failures
    return { items: [], totalCount: 0, page: 1, pageSize: 9, hasMore: false };
  }
}
