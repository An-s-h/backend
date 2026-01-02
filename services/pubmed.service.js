import axios from "axios";
import { DOMParser } from "xmldom";

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
        `PubMed request timeout, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

export async function searchPubMed({ q = "" } = {}) {
  const key = `pm:${q}`;
  const cached = getCache(key);
  if (cached) return cached;

  try {
    // Step 1: Get PMIDs with retry logic and increased timeout
    const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi`;
    const esearchParams = new URLSearchParams({
      db: "pubmed",
      term: q || "oncology",
      retmode: "json",
      retmax: "9",
    });
    
    const idsResp = await retryWithBackoff(async () => {
      return await axios.get(`${esearchUrl}?${esearchParams}`, {
        timeout: 20000, // Increased from 10000 to 20000ms
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CuraLink/1.0)',
        },
      });
    });
    
    const ids = idsResp.data?.esearchresult?.idlist || [];
    if (ids.length === 0) return [];

    // Step 2: Fetch detailed metadata with EFetch with retry logic and increased timeout
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const efetchParams = new URLSearchParams({
      db: "pubmed",
      id: ids.join(","),
      retmode: "xml",
    });
    
    const xmlResp = await retryWithBackoff(async () => {
      return await axios.get(`${efetchUrl}?${efetchParams}`, {
        timeout: 30000, // Increased from 15000 to 30000ms
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; CuraLink/1.0)',
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
      const volume = getText("Volume");
      const issue = getText("Issue");
      const Pages = getText("MedlinePgn");
      
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
          const initials = a.getElementsByTagName("Initials")[0]?.textContent || "";
          return `${fore} ${last}`.trim() || `${initials} ${last}`.trim();
        })
        .filter(Boolean);

      // Get keywords
      const keywords = getAllText("Keyword").filter(Boolean);

      // Get MeSH terms
      const meshTerms = Array.from(
        article.getElementsByTagName("DescriptorName")
      )
        .map((term) => term.textContent || "")
        .filter(Boolean);

      // Get publication type
      const publicationTypes = Array.from(
        article.getElementsByTagName("PublicationType")
      )
        .map((type) => type.textContent || "")
        .filter(Boolean);

      // Get language
      const language = getText("Language");

      // Get country
      const country = getText("Country");

      // Get affiliation (first author's affiliation if available)
      const affiliations = Array.from(
        article.getElementsByTagName("Affiliation")
      )
        .map((aff) => aff.textContent || "")
        .filter(Boolean);

      return {
        pmid,
        title,
        journal,
        year: pubYear,
        month: pubMonth,
        day: pubDay,
        authors,
        volume,
        issue,
        Pages,
        doi,
        abstract,
        keywords: keywords.length > 0 ? keywords : undefined,
        meshTerms: meshTerms.length > 0 ? meshTerms : undefined,
        publicationTypes: publicationTypes.length > 0 ? publicationTypes : undefined,
        language: language || undefined,
        country: country || undefined,
        affiliations: affiliations.length > 0 ? affiliations : undefined,
        url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
      };
    });

    setCache(key, items);
    return items;
  } catch (e) {
    // More detailed error logging
    if (e.code === "ECONNABORTED" || e.message?.includes("timeout")) {
      console.error("PubMed fetch error: timeout exceeded after retries", e.message);
    } else {
      console.error("PubMed fetch error:", e.message);
    }
    // Return empty array instead of throwing to prevent cascading failures
    return [];
  }
}
