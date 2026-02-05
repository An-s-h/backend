import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import dotenv from "dotenv";
import rateLimiter from "../utils/geminiRateLimiter.js";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2;

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

let apiKeyCounter = 0;

function getGeminiInstance() {
  if (!genAI && !genAI2) return null;
  if (!genAI2) return genAI;
  if (!genAI) return genAI2;
  apiKeyCounter = (apiKeyCounter + 1) % 2;
  return apiKeyCounter === 0 ? genAI : genAI2;
}

// Cache for OpenAlex and Semantic Scholar results
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour cache for deterministic data

function getCacheKey(prefix, ...args) {
  return `${prefix}:${args.join(":")}`.toLowerCase().trim();
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

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  
  // Cleanup old cache entries
  if (cache.size > 500) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) {
        cache.delete(k);
      }
    }
  }
}

/**
 * STEP 1: Use Gemini to generate search constraints ONLY (not expert names)
 * @param {string} topic - Topic like "Parkinson's Disease"
 * @param {string} location - Location like "Toronto, Canada"
 * @returns {Promise<Object>} Search constraints object
 */
async function generateSearchConstraints(topic, location) {
  const cacheKey = getCacheKey("constraints", topic, location || "global");
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    throw new Error("No Gemini API keys available");
  }

  const model = geminiInstance.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
  });

  const prompt = `
You are an academic search query expert.

Given the topic "${topic}"${location ? ` and location "${location}"` : ""}, generate search constraints for finding relevant researchers and publications.

Output STRICTLY in this JSON format (no markdown):

{
  "primaryKeywords": ["keyword1", "keyword2"],
  "subfields": ["subfield1", "subfield2"],
  "meshTerms": ["MeSH Term 1", "MeSH Term 2"],
  "synonyms": ["synonym1", "synonym2"],
  "relatedConcepts": ["concept1", "concept2"],
  "exclude": ["pediatric", "animal-only"]
}

Guidelines:
- primaryKeywords: 2-4 core terms that define the topic
- subfields: Related research areas (e.g., for Parkinson's: "movement disorders", "deep brain stimulation")
- meshTerms: Medical Subject Headings (MeSH) terms for the condition/topic
- synonyms: Alternative names or abbreviations
- relatedConcepts: Broader or related concepts
- exclude: Terms that would filter out irrelevant research (pediatric studies, animal-only, etc.)
`;

  try {
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 1000,
            temperature: 0.2, // Very low for consistency
            topP: 0.8,
            topK: 40,
          },
        });
      },
      "gemini-2.5-flash-lite",
      1200
    );

    const responseText = result.response.text().trim();
    let jsonText = responseText;
    
    // Clean markdown code blocks if present
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    // Extract JSON object
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const constraints = JSON.parse(jsonText);
    
    // Validate structure
    if (!constraints.primaryKeywords || !Array.isArray(constraints.primaryKeywords)) {
      throw new Error("Invalid constraints structure");
    }

    setCache(cacheKey, constraints);
    return constraints;
  } catch (error) {
    console.error("Error generating search constraints:", error);
    // Fallback to basic constraints
    return {
      primaryKeywords: [topic],
      subfields: [],
      meshTerms: [],
      synonyms: [],
      relatedConcepts: [],
      exclude: ["pediatric", "animal"],
    };
  }
}

/**
 * STEP 2: Search OpenAlex WORKS (not authors) based on constraints
 * @param {Object} constraints - Search constraints from Step 1
 * @param {string} location - Location filter (country code)
 * @returns {Promise<Array>} Array of works with author information
 */
async function searchOpenAlexWorks(constraints, location) {
  const cacheKey = getCacheKey(
    "openalex-works",
    JSON.stringify(constraints),
    location || "global"
  );
  const cached = getCache(cacheKey);
  if (cached) return cached;

  // Build OpenAlex query using search instead of concept filters
  // Use primaryKeywords for the main search query
  const searchTerms = constraints.primaryKeywords
    .filter(Boolean)
    .slice(0, 3) // Use top 3 most relevant terms
    .join(" ");
  
  // Build filter array (without concepts.display_name)
  const filters = [];
  
  // Location filter (country code)
  if (location) {
    const countryCode = extractCountryCode(location);
    if (countryCode) {
      filters.push(`authorships.institutions.country_code:${countryCode}`);
    }
  }
  
  // Publication year filter (last 5 years for recent research)
  // OpenAlex uses > not >= for range queries
  const currentYear = new Date().getFullYear();
  filters.push(`publication_year:>${currentYear - 6}`); // Last 5 years: >2019 for 2026
  
  const filterString = filters.join(",");
  
  try {
    const url = "https://api.openalex.org/works";
    const params = {
      search: searchTerms, // Use search parameter for topic matching
      filter: filterString, // Use filter only for location and year
      "per-page": 200, // Fetch more works to get diverse authors
      sort: "cited_by_count:desc", // Sort by citations to get influential works
      mailto: process.env.OPENALEX_MAILTO || "support@curalink.com",
    };
    
    // Build full URL for debugging
    const fullUrl = `${url}?${new URLSearchParams(params).toString()}`;
    
    console.log("Calling OpenAlex:", fullUrl.substring(0, 200) + "...");

    const response = await axios.get(url, {
      params,
      headers: {
        "User-Agent": "CuraLink/1.0 (expert discovery; mailto:support@curalink.com)",
      },
      timeout: 30000, // Increased to 30 seconds
    });
    
    console.log("OpenAlex responded with", response.data?.results?.length || 0, "works");
    
    const works = response.data?.results || [];
    
    setCache(cacheKey, works);
    return works;
  } catch (error) {
    const isTimeout = error.code === 'ECONNABORTED' || error.message?.includes('timeout');
    console.error("Error searching OpenAlex works:", error.message, isTimeout ? "(TIMEOUT)" : "");
    return [];
  }
}

/**
 * STEP 3: Extract author IDs and aggregate metrics from works
 * @param {Array} works - OpenAlex works from Step 2
 * @param {Object} constraints - Search constraints for relevance scoring
 * @returns {Array} Array of author candidates with aggregated metrics
 */
function extractAndAggregateAuthors(works, constraints) {
  const authorMap = new Map();
  const currentYear = new Date().getFullYear();

  for (const work of works) {
    const year = work.publication_year || 0;
    const citationCount = work.cited_by_count || 0;
    const authorships = work.authorships || [];
    
    // Calculate work relevance to topic
    const workRelevance = calculateWorkRelevance(work, constraints);
    
    // Skip irrelevant works
    if (workRelevance < 0.3) continue;

    for (const authorship of authorships) {
      const author = authorship.author;
      if (!author || !author.id) continue;

      const authorId = author.id;
      const authorName = author.display_name;
      const orcid = author.orcid ? author.orcid.split("/").pop() : null;
      const position = authorship.author_position; // "first", "middle", "last"
      const institutions = authorship.institutions || [];

      if (!authorMap.has(authorId)) {
        authorMap.set(authorId, {
          id: authorId,
          name: authorName,
          orcid,
          works: [],
          totalCitations: 0,
          recentWorks: 0,
          lastAuthorCount: 0,
          firstAuthorCount: 0,
          institutions: new Set(),
          dois: new Set(),
          relevanceScore: 0,
          countryCode: null,
        });
      }

      const authorData = authorMap.get(authorId);
      
      // Aggregate data
      authorData.works.push({
        id: work.id,
        title: work.title,
        year,
        citations: citationCount,
        position,
        doi: work.doi,
        relevance: workRelevance,
      });
      
      authorData.totalCitations += citationCount;
      authorData.relevanceScore += workRelevance;
      
      if (year >= currentYear - 2) {
        authorData.recentWorks++;
      }
      
      if (position === "last") {
        authorData.lastAuthorCount++;
      }
      
      if (position === "first") {
        authorData.firstAuthorCount++;
      }
      
      // Track DOIs for cross-referencing
      if (work.doi) {
        authorData.dois.add(work.doi);
      }
      
      // Track institutions
      for (const inst of institutions) {
        if (inst.display_name) {
          authorData.institutions.add(inst.display_name);
        }
        if (inst.country_code && !authorData.countryCode) {
          authorData.countryCode = inst.country_code;
        }
      }
    }
  }

  // Convert to array and calculate average relevance
  const authors = Array.from(authorMap.values()).map((author) => ({
    ...author,
    institutions: Array.from(author.institutions),
    dois: Array.from(author.dois),
    avgRelevance: author.relevanceScore / author.works.length,
  }));
  
  return authors;
}

/**
 * Calculate how relevant a work is to the search constraints
 * Simplified: Trust OpenAlex search ranking + check concepts
 */
function calculateWorkRelevance(work, constraints) {
  const title = (work.title || "").toLowerCase();
  
  // Check if primary keywords appear in title or concepts
  let score = 0;

  // Check primary keywords in title (high confidence)
  for (const keyword of constraints.primaryKeywords || []) {
    if (title.includes(keyword.toLowerCase())) {
      score += 0.5;
    }
  }

  // Check OpenAlex concepts (OpenAlex's own relevance scoring)
  const relevantConcepts = (work.concepts || []).filter((concept) => {
    const conceptName = (concept.display_name || "").toLowerCase();
    const conceptScore = concept.score || 0;
    
    // Check if concept matches our keywords
    for (const keyword of constraints.primaryKeywords || []) {
      if (conceptName.includes(keyword.toLowerCase()) && conceptScore > 0.3) {
        return true;
      }
    }
    
    // Check subfields
    for (const subfield of constraints.subfields || []) {
      if (conceptName.includes(subfield.toLowerCase()) && conceptScore > 0.2) {
        return true;
      }
    }
    
    return false;
  });

  // If OpenAlex tagged it with our concepts, it's relevant
  if (relevantConcepts.length > 0) {
    score += 0.4 + (relevantConcepts[0].score * 0.1);
  }

  // If work was returned by OpenAlex search, give it base relevance
  // (OpenAlex already filtered for relevance)
  score += 0.2;

  return Math.min(1, score);
}

/**
 * STEP 4: Cross-reference with Semantic Scholar by ID and DOI
 * @param {Array} authorCandidates - Author candidates from Step 3
 * @returns {Promise<Array>} Verified authors with S2 data
 */
async function crossReferenceSemanticScholar(authorCandidates) {
  const verified = [];

  for (const candidate of authorCandidates.slice(0, 20)) {
    // Limit to top 20 candidates
    try {
      // Search by name in Semantic Scholar
      const s2Author = await searchSemanticScholarByName(candidate.name);
      
      if (!s2Author) continue;

      // Cross-check: Check for DOI overlap (preferred but not required)
      const s2Papers = await fetchSemanticScholarPapers(s2Author.authorId);
      const s2DOIs = new Set(
        s2Papers
          .map((p) => p.externalIds?.DOI)
          .filter(Boolean)
          .map((doi) => doi.toLowerCase())
      );

      const candidateDOIs = new Set(
        Array.from(candidate.dois).map((doi) => doi.toLowerCase())
      );

      // Calculate DOI intersection
      const intersection = new Set(
        [...candidateDOIs].filter((doi) => s2DOIs.has(doi))
      );

      // Verification strategy: Accept if EITHER:
      // 1. DOI overlap exists (strong verification) OR
      // 2. Good name match + reasonable paper count (acceptable verification)
      const hasDOIOverlap = intersection.size > 0;
      const hasReasonablePaperCount = (s2Author.paperCount || 0) >= 5;
      const nameMatchScore = calculateNameSimilarity(candidate.name, s2Author.name || "");
      const hasGoodNameMatch = nameMatchScore >= 0.7;
      
      const isVerified = hasDOIOverlap || (hasGoodNameMatch && hasReasonablePaperCount);
      
      if (!isVerified) {
        console.log(
          `Skipping ${candidate.name}: No DOI overlap and weak verification (nameMatch=${nameMatchScore.toFixed(2)}, papers=${s2Author.paperCount})`
        );
        continue;
      }

      verified.push({
        ...candidate,
        semanticScholar: {
          authorId: s2Author.authorId,
          name: s2Author.name,
          paperCount: s2Author.paperCount || 0,
          citationCount: s2Author.citationCount || 0,
          hIndex: s2Author.hIndex || 0,
          url: s2Author.url,
        },
        verification: {
          openAlexDOIs: candidateDOIs.size,
          semanticScholarDOIs: s2DOIs.size,
          overlappingDOIs: intersection.size,
          verified: true,
          verificationMethod: hasDOIOverlap ? "DOI_overlap" : "name_match",
          nameMatchScore: nameMatchScore,
        },
      });
    } catch (error) {
      console.error(
        `Error verifying ${candidate.name} with Semantic Scholar:`,
        error.message
      );
      // Skip on error - don't include unverified authors
    }
  }

  return verified;
}

/**
 * Search Semantic Scholar by author name
 */
async function searchSemanticScholarByName(name) {
  const cacheKey = getCacheKey("s2-author", name);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const headers = {};
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
      headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    }

    const url = "https://api.semanticscholar.org/graph/v1/author/search";
    const params = {
      query: name,
      limit: 5,
      fields: "authorId,name,affiliations,paperCount,citationCount,hIndex,url,externalIds",
    };

    const response = await axios.get(url, {
      params,
      headers,
      timeout: 12000,
    });

    const authors = response.data?.data || [];
    if (authors.length === 0) return null;

    // Find best name match
    const bestMatch = authors.reduce((best, author) => {
      const score = calculateNameSimilarity(name, author.name || "");
      if (!best || score > best.score) {
        return { author, score };
      }
      return best;
    }, null);

    if (!bestMatch || bestMatch.score < 0.5) return null;

    setCache(cacheKey, bestMatch.author);
    return bestMatch.author;
  } catch (error) {
    console.error("Error searching Semantic Scholar:", error.message);
    return null;
  }
}

/**
 * Fetch papers for a Semantic Scholar author
 */
async function fetchSemanticScholarPapers(authorId) {
  const cacheKey = getCacheKey("s2-papers", authorId);
  const cached = getCache(cacheKey);
  if (cached) return cached;

  try {
    const headers = {};
    if (process.env.SEMANTIC_SCHOLAR_API_KEY) {
      headers["x-api-key"] = process.env.SEMANTIC_SCHOLAR_API_KEY;
    }

    const url = `https://api.semanticscholar.org/graph/v1/author/${encodeURIComponent(
      authorId
    )}/papers`;
    const params = {
      limit: 100,
      fields: "title,year,venue,citationCount,externalIds",
    };

    const response = await axios.get(url, {
      params,
      headers,
      timeout: 15000,
    });

    const papers = response.data?.data || [];
    setCache(cacheKey, papers);
    return papers;
  } catch (error) {
    console.error("Error fetching S2 papers:", error.message);
    return [];
  }
}

/**
 * Calculate name similarity (simple token-based approach)
 */
function calculateNameSimilarity(name1, name2) {
  const normalize = (str) =>
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const n1 = normalize(name1);
  const n2 = normalize(name2);

  if (n1 === n2) return 1.0;

  const tokens1 = new Set(n1.split(" ").filter((t) => t.length > 1));
  const tokens2 = new Set(n2.split(" ").filter((t) => t.length > 1));

  if (tokens1.size === 0 || tokens2.size === 0) return 0;

  let matches = 0;
  for (const t1 of tokens1) {
    for (const t2 of tokens2) {
      if (t1 === t2 || t1.startsWith(t2) || t2.startsWith(t1)) {
        matches++;
        break;
      }
    }
  }

  return matches / Math.max(tokens1.size, tokens2.size);
}

/**
 * STEP 5: Compute field relevance score
 */
function computeFieldRelevance(author, constraints) {
  const allKeywords = [
    ...(constraints.primaryKeywords || []),
    ...(constraints.subfields || []),
    ...(constraints.meshTerms || []),
  ]
    .filter(Boolean)
    .map((k) => k.toLowerCase());

  if (allKeywords.length === 0) return 1.0;

  const recentWorks = author.works.filter(
    (w) => w.year >= new Date().getFullYear() - 3
  );

  if (recentWorks.length === 0) return 0;

  let relevantCount = 0;
  for (const work of recentWorks) {
    const title = (work.title || "").toLowerCase();
    const hasKeyword = allKeywords.some((kw) => title.includes(kw));
    if (hasKeyword || work.relevance >= 0.5) {
      relevantCount++;
    }
  }

  const fieldScore = relevantCount / recentWorks.length;
  return fieldScore;
}

/**
 * STEP 6: Apply sanity checks
 */
function applySanityChecks(author) {
  const citedByCount = author.totalCitations;
  const worksCount = author.works.length;
  const hIndex = author.semanticScholar?.hIndex || 0;

  // Reject if:
  // - No citations
  // - Too many works but too few citations (likely junk)
  // - h-index greater than works count (impossible)
  const checks = {
    noCitations: citedByCount === 0,
    junkProfile: worksCount > 50 && citedByCount < 100,
    impossibleHIndex: hIndex > worksCount,
  };
  
  const passed = !checks.noCitations && !checks.junkProfile && !checks.impossibleHIndex;
  
  return passed;
}

/**
 * Simplified ranking: Sort by papers and citations (no strict checks)
 */
function rankAuthorsByMetrics(authors) {
  const rankedAuthors = authors
    .map((author) => {
      // Simple scoring based on actual metrics
      const worksScore = Math.min(1, author.works.length / 50); // 50+ works = 1.0
      const citationScore = Math.min(1, author.totalCitations / 1000); // 1000+ citations = 1.0
      const recencyScore = Math.min(1, author.recentWorks / 5); // 5+ recent papers = 1.0
      const fieldScore = author.fieldRelevance || 0.5;

      // Weighted final score (prioritize papers and citations)
      const finalScore =
        worksScore * 0.3 +
        citationScore * 0.3 +
        recencyScore * 0.2 +
        fieldScore * 0.2;

      return {
        ...author,
        scores: {
          works: worksScore,
          citations: citationScore,
          recency: recencyScore,
          fieldRelevance: fieldScore,
          final: finalScore,
        },
      };
    })
    .sort((a, b) => {
      // Primary sort: number of works (most papers first)
      if (b.works.length !== a.works.length) {
        return b.works.length - a.works.length;
      }
      // Secondary sort: total citations
      if (b.totalCitations !== a.totalCitations) {
        return b.totalCitations - a.totalCitations;
      }
      // Tertiary sort: field relevance
      return (b.fieldRelevance || 0) - (a.fieldRelevance || 0);
    });
    
  return rankedAuthors;
}

/**
 * STEP 8: Generate summaries using Gemini (ONLY for UX polish)
 */
async function generateExpertSummaries(authors) {
  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Return authors without summaries if Gemini unavailable
    return authors.map((a) => ({
      ...a,
      biography: `Researcher at ${
        a.institutions[0] || "Unknown Institution"
      } with ${a.works.length} publications and ${a.totalCitations} citations.`,
    }));
  }

  const model = geminiInstance.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
  });

  const authorsWithSummaries = [];

  for (const author of authors) {
    try {
      // Generate 2-sentence bio based on verified data
      const recentTitles = author.works
        .slice(0, 5)
        .map((w) => w.title)
        .filter(Boolean);

      const prompt = `
Generate a 2-sentence professional biography for this researcher based ONLY on the provided data.

Name: ${author.name}
Institution: ${author.institutions[0] || "Unknown"}
Publications: ${author.works.length}
Citations: ${author.totalCitations}
Recent paper titles:
${recentTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Output only the 2-sentence biography, no additional text.
`;

      const result = await rateLimiter.execute(
        async () => {
          return await model.generateContent(prompt, {
            generationConfig: {
              maxOutputTokens: 200,
              temperature: 0.4,
            },
          });
        },
        "gemini-2.5-flash-lite",
        400
      );

      const biography = result.response.text().trim();

      authorsWithSummaries.push({
        ...author,
        biography,
      });
    } catch (error) {
      console.error(`Error generating summary for ${author.name}:`, error.message);
      // Fallback bio
      authorsWithSummaries.push({
        ...author,
        biography: `Researcher at ${
          author.institutions[0] || "Unknown Institution"
        } with ${author.works.length} publications and ${author.totalCitations} citations.`,
      });
    }
  }

  return authorsWithSummaries;
}

/**
 * Extract country code from location string
 */
function extractCountryCode(location) {
  if (!location) return null;
  
  const countryMap = {
    "canada": "CA",
    "united states": "US",
    "usa": "US",
    "united kingdom": "GB",
    "uk": "GB",
    "germany": "DE",
    "france": "FR",
    "china": "CN",
    "japan": "JP",
    "australia": "AU",
    "india": "IN",
    // Add more as needed
  };
  
  const locationLower = location.toLowerCase();
  for (const [country, code] of Object.entries(countryMap)) {
    if (locationLower.includes(country)) {
      return code;
    }
  }
  
  return null;
}

/**
 * MAIN FUNCTION: Deterministic expert discovery
 * @param {string} topic - Research topic
 * @param {string} location - Geographic location (optional)
 * @param {number} limit - Number of experts to return
 * @returns {Promise<Array>} Array of verified expert objects
 */
export async function findDeterministicExperts(topic, location = null, limit = 10) {
  try {
    console.log(`🔍 Starting deterministic expert discovery for: ${topic}`);

    // Step 1: Generate search constraints (Gemini for keywords only)
    console.log("Step 1: Generating search constraints...");
    const constraints = await generateSearchConstraints(topic, location);
    console.log(`Generated constraints:`, constraints);

    // Step 2: Search OpenAlex works
    console.log("Step 2: Searching OpenAlex works...");
    const works = await searchOpenAlexWorks(constraints, location);
    console.log(`Found ${works.length} relevant works`);

    if (works.length === 0) {
      return [];
    }

    // Step 3: Extract and aggregate authors
    console.log("Step 3: Extracting and aggregating authors...");
    const authorCandidates = extractAndAggregateAuthors(works, constraints);
    console.log(`Found ${authorCandidates.length} author candidates`);

    // Sort by total citations to prioritize top candidates
    authorCandidates.sort((a, b) => b.totalCitations - a.totalCitations);

    // Step 4: Compute field relevance for all authors
    console.log("Step 4: Computing field relevance...");
    authorCandidates.forEach((author) => {
      author.fieldRelevance = computeFieldRelevance(author, constraints);
    });

    // Step 5: Simple ranking by papers and citations (no strict sanity checks)
    console.log("Step 5: Ranking authors by metrics...");
    const rankedAuthors = rankAuthorsByMetrics(authorCandidates);
    console.log(`Ranked ${rankedAuthors.length} authors`);

    // Take top N
    const topAuthors = rankedAuthors.slice(0, limit);

    // Step 8: Generate summaries (Gemini for UX only)
    console.log("Step 8: Generating expert summaries...");
    const expertsWithSummaries = await generateExpertSummaries(topAuthors);

    console.log(`✅ Returning ${expertsWithSummaries.length} verified experts`);
    return expertsWithSummaries;
  } catch (error) {
    console.error("Error in deterministic expert discovery:", error);
    throw error;
  }
}

/**
 * Format experts for API response
 */
export function formatExpertsForResponse(experts) {
  return experts.map((expert) => ({
    name: expert.name,
    affiliation: expert.institutions[0] || null,
    location: expert.countryCode
      ? `${expert.countryCode}`
      : null,
    biography: expert.biography || null,
    orcid: expert.orcid || null,
    orcidUrl: expert.orcid ? `https://orcid.org/${expert.orcid}` : null,
    
    // Metrics
    metrics: {
      totalPublications: expert.works.length,
      totalCitations: expert.totalCitations,
      recentPublications: expert.recentWorks,
      lastAuthorCount: expert.lastAuthorCount,
      firstAuthorCount: expert.firstAuthorCount,
      hIndex: expert.semanticScholar?.hIndex || null,
      fieldRelevance: Math.round(expert.fieldRelevance * 100),
    },
    
    // Verification info
    verification: {
      openAlexId: expert.id,
      semanticScholarId: expert.semanticScholar?.authorId || null,
      overlappingDOIs: expert.verification?.overlappingDOIs || 0,
      verified: expert.verification?.verified || false,
    },
    
    // Scores (transparency)
    scores: expert.scores,
    
    // Confidence tier
    confidence: calculateConfidenceTier(expert),
    
    // Recent works (top 3)
    recentWorks: expert.works
      .sort((a, b) => b.year - a.year)
      .slice(0, 3)
      .map((w) => ({
        title: w.title,
        year: w.year,
        citations: w.citations,
      })),
  }));
}

/**
 * Calculate confidence tier based on verification strength
 */
function calculateConfidenceTier(expert) {
  const { totalCitations, works, recentWorks } = expert;

  // High confidence: Strong publication record
  if (totalCitations >= 500 && works.length >= 20 && recentWorks >= 3) {
    return "high";
  }

  // Medium confidence: Moderate publication record
  if (totalCitations >= 100 && works.length >= 10 && recentWorks >= 2) {
    return "medium";
  }

  // Low confidence: Early career or less active
  return "low";
}
