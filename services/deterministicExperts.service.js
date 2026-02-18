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
      1200,
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
    if (
      !constraints.primaryKeywords ||
      !Array.isArray(constraints.primaryKeywords)
    ) {
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
    location || "global",
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
        "User-Agent":
          "CuraLink/1.0 (expert discovery; mailto:support@curalink.com)",
      },
      timeout: 30000, // Increased to 30 seconds
    });

    console.log(
      "OpenAlex responded with",
      response.data?.results?.length || 0,
      "works",
    );

    const works = response.data?.results || [];

    setCache(cacheKey, works);
    return works;
  } catch (error) {
    const isTimeout =
      error.code === "ECONNABORTED" || error.message?.includes("timeout");
    console.error(
      "Error searching OpenAlex works:",
      error.message,
      isTimeout ? "(TIMEOUT)" : "",
    );
    return [];
  }
}

/**
 * STEP 3: Extract author IDs and aggregate metrics from works
 * @param {Array} works - OpenAlex works from Step 2
 * @param {Object} constraints - Search constraints for relevance scoring
 * @param {string} location - Location filter (optional)
 * @returns {Array} Array of author candidates with aggregated metrics
 */
function extractAndAggregateAuthors(works, constraints, location = null) {
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
          recentTopicWorks: 0, // last 5 years (topic-specific)
          lastAuthorCount: 0,
          firstAuthorCount: 0,
          correspondingAuthorCount: 0,
          institutions: new Set(),
          dois: new Set(),
          relevanceScore: 0,
          countryCode: null,
          countryCodes: new Set(),
        });
      }

      const authorData = authorMap.get(authorId);
      const isTrial = isClinicalTrialWork(work);
      const isCorresponding =
        authorship.is_corresponding === true ||
        (work.corresponding_author_ids || []).includes(authorId);

      // Aggregate data (topic-specific metrics)
      authorData.works.push({
        id: work.id,
        title: work.title,
        year,
        citations: citationCount,
        position,
        doi: work.doi,
        relevance: workRelevance,
        isTrial,
      });

      authorData.totalCitations += citationCount;
      authorData.relevanceScore += workRelevance;

      if (year >= currentYear - 2) {
        authorData.recentWorks++;
      }
      if (year >= currentYear - 5) {
        authorData.recentTopicWorks++;
      }

      if (position === "last") {
        authorData.lastAuthorCount++;
      }
      if (position === "first") {
        authorData.firstAuthorCount++;
      }
      if (isCorresponding) {
        authorData.correspondingAuthorCount++;
      }

      // Track DOIs for cross-referencing
      if (work.doi) {
        authorData.dois.add(work.doi);
      }

      // Track institutions and raw institution names for location matching
      for (const inst of institutions) {
        if (inst.display_name) {
          authorData.institutions.add(inst.display_name);
          // Also store lowercase for city matching
          if (!authorData.institutionNamesLower) {
            authorData.institutionNamesLower = new Set();
          }
          authorData.institutionNamesLower.add(inst.display_name.toLowerCase());
        }
        // Track all country codes (authors can have multiple institutions in different countries)
        if (inst.country_code) {
          authorData.countryCodes.add(inst.country_code);
          // Set primary countryCode to the first one found (for backward compatibility)
          if (!authorData.countryCode) {
            authorData.countryCode = inst.country_code;
          }
        }
      }
    }
  }

  // Convert to array; add topic-specific and trial metrics
  let authors = Array.from(authorMap.values()).map((author) => {
    const topicWorksCount = author.works.length;
    const topicCitationCount = author.totalCitations;
    const trialWorks = author.works.filter((w) => w.isTrial);
    const trialWorkCount = trialWorks.length;
    const trialLastAuthorCount = trialWorks.filter(
      (w) => w.position === "last",
    ).length;
    const trialRecentCount = trialWorks.filter(
      (w) => (w.year || 0) >= currentYear - 5,
    ).length;
    const rawPiScore = trialLastAuthorCount * 0.7 + trialWorkCount * 0.3; // normalized later

    return {
      ...author,
      institutions: Array.from(author.institutions),
      institutionNamesLower: author.institutionNamesLower
        ? Array.from(author.institutionNamesLower)
        : [],
      dois: Array.from(author.dois),
      countryCodes: Array.from(author.countryCodes),
      avgRelevance: topicWorksCount
        ? author.relevanceScore / topicWorksCount
        : 0,
      topicWorksCount,
      topicCitationCount,
      trialWorkCount,
      trialLastAuthorCount,
      trialRecentCount,
      rawPiScore,
    };
  });

  // FILTER: Apply location filter if specified (STRICT filtering)
  if (location) {
    const beforeFilter = authors.length;
    authors = authors.filter((author) =>
      authorMatchesLocation(author, location),
    );
    const afterFilter = authors.length;
    if (beforeFilter !== afterFilter) {
      console.log(
        `Location filter "${location}": ${beforeFilter} → ${afterFilter} authors (filtered out ${beforeFilter - afterFilter})`,
      );
    }
  }

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
    score += 0.4 + relevantConcepts[0].score * 0.1;
  }

  // If work was returned by OpenAlex search, give it base relevance
  // (OpenAlex already filtered for relevance)
  score += 0.2;

  return Math.min(1, score);
}

/**
 * Detect if a work is a clinical trial (for PI prioritization).
 * Uses publication type hints, title keywords, and MeSH when available.
 * @param {Object} work - OpenAlex work object
 * @returns {boolean}
 */
function isClinicalTrialWork(work) {
  const title = (work.title || "").toLowerCase();
  const trialTitlePatterns = [
    "randomized",
    "placebo",
    "phase i ",
    "phase ii ",
    "phase iii ",
    "phase 1 ",
    "phase 2 ",
    "phase 3 ",
    "clinical trial",
    "rct",
    "controlled trial",
    "double-blind",
    "single-blind",
  ];
  if (trialTitlePatterns.some((p) => title.includes(p))) return true;

  // MeSH (PubMed works): Clinical Trial, Randomized Controlled Trial, etc.
  const mesh = work.mesh || [];
  const trialMeshTerms = [
    "clinical trial",
    "randomized controlled trial",
    "controlled clinical trial",
    "clinical trials as topic",
  ];
  for (const m of mesh) {
    const name = (m.descriptor_name || "").toLowerCase();
    if (trialMeshTerms.some((t) => name.includes(t))) return true;
  }

  return false;
}

/**
 * Detect if the user query indicates clinical trial / PI intent.
 * @param {string} topic - Raw topic string
 * @returns {boolean}
 */
function detectClinicalTrialIntent(topic) {
  if (!topic || typeof topic !== "string") return false;
  const lower = topic.toLowerCase();
  const patterns = [
    "trial",
    "phase ii",
    "phase iii",
    "phase 2",
    "phase 3",
    "investigator",
    "principal investigator",
    "pi ",
    "clinical trial",
    "rct",
    "randomized",
  ];
  return patterns.some((p) => lower.includes(p));
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
          .map((doi) => doi.toLowerCase()),
      );

      const candidateDOIs = new Set(
        Array.from(candidate.dois).map((doi) => doi.toLowerCase()),
      );

      // Calculate DOI intersection
      const intersection = new Set(
        [...candidateDOIs].filter((doi) => s2DOIs.has(doi)),
      );

      // Verification strategy: Accept if EITHER:
      // 1. DOI overlap exists (strong verification) OR
      // 2. Good name match + reasonable paper count (acceptable verification)
      const hasDOIOverlap = intersection.size > 0;
      const hasReasonablePaperCount = (s2Author.paperCount || 0) >= 5;
      const nameMatchScore = calculateNameSimilarity(
        candidate.name,
        s2Author.name || "",
      );
      const hasGoodNameMatch = nameMatchScore >= 0.7;

      const isVerified =
        hasDOIOverlap || (hasGoodNameMatch && hasReasonablePaperCount);

      if (!isVerified) {
        console.log(
          `Skipping ${candidate.name}: No DOI overlap and weak verification (nameMatch=${nameMatchScore.toFixed(2)}, papers=${s2Author.paperCount})`,
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
        error.message,
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
      fields:
        "authorId,name,affiliations,paperCount,citationCount,hIndex,url,externalIds",
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
      authorId,
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
 * STEP 5: Compute field relevance score (STRICT - prevents off-topic researchers from ranking high)
 * Now requires PRIMARY keywords (not just subfields) and looks at ALL works, not just recent
 */
function computeFieldRelevance(author, constraints) {
  const primaryKeywords = (constraints.primaryKeywords || [])
    .filter(Boolean)
    .map((k) => k.toLowerCase());

  const allKeywords = [
    ...primaryKeywords,
    ...(constraints.subfields || []),
    ...(constraints.meshTerms || []),
  ]
    .filter(Boolean)
    .map((k) => k.toLowerCase());

  if (allKeywords.length === 0) return 1.0;
  if (primaryKeywords.length === 0) return 0.5; // No primary keywords = weak signal

  // Look at ALL works (not just recent) to assess overall research focus
  const allWorks = author.works || [];
  if (allWorks.length === 0) return 0;

  let stronglyRelevantCount = 0; // Works with PRIMARY keywords
  let moderatelyRelevantCount = 0; // Works with subfields/related terms
  let totalWorks = allWorks.length;

  for (const work of allWorks) {
    const title = (work.title || "").toLowerCase();

    // STRICT: Check for PRIMARY keywords first (required for strong relevance)
    const hasPrimaryKeyword = primaryKeywords.some((kw) => title.includes(kw));

    // Also check work relevance score (from OpenAlex concepts)
    const workRelevance = work.relevance || 0;

    if (hasPrimaryKeyword || workRelevance >= 0.6) {
      // Strong match: primary keyword in title OR high OpenAlex relevance
      stronglyRelevantCount++;
    } else {
      // Moderate match: subfield keywords OR medium relevance
      const hasSubfieldKeyword = (constraints.subfields || []).some((sf) =>
        title.includes(sf.toLowerCase()),
      );
      if (hasSubfieldKeyword || workRelevance >= 0.4) {
        moderatelyRelevantCount++;
      }
    }
  }

  // Weighted scoring: strongly relevant works count more
  const strongScore = (stronglyRelevantCount / totalWorks) * 1.0;
  const moderateScore = (moderatelyRelevantCount / totalWorks) * 0.3;

  // Require at least SOME primary keyword matches to avoid off-topic researchers
  const fieldScore = strongScore + moderateScore;

  // Penalty: if less than 10% of works have primary keywords, heavily penalize
  const primaryKeywordRatio = stronglyRelevantCount / totalWorks;
  if (primaryKeywordRatio < 0.1 && totalWorks >= 5) {
    // Researcher has many works but few are topic-relevant → likely off-topic
    return fieldScore * 0.3; // Heavy penalty
  }

  return Math.min(1.0, fieldScore);
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

  const passed =
    !checks.noCitations && !checks.junkProfile && !checks.impossibleHIndex;

  return passed;
}

/**
 * Calculate recency decay score for a publication year
 * Extended duration scoring for experts: 0-4 years (weight 1), 5-7 years (0.7), 8-10 years (0.4), >10 years (0.2)
 * @param {number} publicationYear - Year the work was published
 * @param {number} currentYear - Current year
 * @returns {number} Recency score between 0 and 1.0
 */
function calculateRecencyDecay(publicationYear, currentYear) {
  if (!publicationYear || publicationYear <= 0) return 0;

  const yearsAgo = currentYear - publicationYear;

  if (yearsAgo < 0) return 1.0; // Future publications (shouldn't happen, but handle gracefully)

  // Extended duration scoring for experts
  if (yearsAgo <= 4) return 1.0; // 0-4 years ago: weight 1.0
  if (yearsAgo >= 5 && yearsAgo <= 7) return 0.7; // 5-7 years ago: weight 0.7
  if (yearsAgo >= 8 && yearsAgo <= 10) return 0.4; // 8-10 years ago: weight 0.4
  return 0.2; // >10 years ago: weight 0.2
}

/**
 * Calculate weighted recency score for an author based on their works
 * Uses decay model: more recent works contribute more to the score
 * @param {Array} works - Array of work objects with {year, citations, ...}
 * @param {number} currentYear - Current year
 * @returns {number} Weighted recency score (0-1)
 */
function calculateAuthorRecencyScore(works, currentYear) {
  if (!works || works.length === 0) return 0;

  let totalDecayScore = 0;
  let validWorks = 0;

  for (const work of works) {
    const year = work.year || 0;
    if (year <= 0) continue;

    const decayScore = calculateRecencyDecay(year, currentYear);
    totalDecayScore += decayScore;
    validWorks++;
  }

  // Average decay score across all works
  return validWorks > 0 ? totalDecayScore / validWorks : 0;
}

/**
 * Rank authors by upgraded deterministic formula: topic works, citations, recency,
 * field relevance, senior authorship, topic dominance, PI score. Optional clinical-trial intent weighting.
 * @param {Array} authors - Authors with topicWorksCount, realWorksCount, fieldRelevance, trial metrics, etc.
 * @param {string|null} location - Optional location for tie-breaking
 * @param {string|null} topic - Optional topic string to detect clinical trial intent
 */
function rankAuthorsByMetrics(authors, location = null, topic = null) {
  const searchCity = extractCityName(location);
  const searchState = extractStateName(location);
  const searchCountryCode = location ? extractCountryCode(location) : null;
  const currentYear = new Date().getFullYear();
  const clinicalTrialIntent = detectClinicalTrialIntent(topic || "");

  const maxRawPiScore =
    authors.length > 0
      ? Math.max(...authors.map((a) => a.rawPiScore || 0), 0)
      : 0;

  const rankedAuthors = authors
    .map((author) => {
      const topicWorksCount =
        author.topicWorksCount ?? author.works?.length ?? 0;
      const realWorksCount = author.realWorksCount ?? author.works?.length ?? 1;
      const citationCount =
        author.realCitationCount ?? author.totalCitations ?? 0;
      const lastAuthorCount = author.lastAuthorCount ?? 0;
      const correspondingAuthorCount = author.correspondingAuthorCount ?? 0;

      const seniorAuthorshipRatio =
        topicWorksCount > 0
          ? (lastAuthorCount + correspondingAuthorCount) / topicWorksCount
          : 0;
      const topicDominance = Math.min(
        1,
        realWorksCount > 0 ? topicWorksCount / realWorksCount : 0,
      );
      const piScore =
        maxRawPiScore > 0
          ? Math.min(1, (author.rawPiScore || 0) / maxRawPiScore)
          : 0;

      const W = Math.min(1, topicWorksCount / 50);
      const C = Math.min(1, citationCount / 1000);
      const R = calculateAuthorRecencyScore(author.works || [], currentYear);
      const F = author.fieldRelevance ?? 0;

      // Hard filters: relaxed so we don't over-drop (was getting ~3 experts vs ~100 before).
      // - Require at least 1 topic work (from our 200-work slice).
      // - Drop only strongly off-topic: fieldRelevance < 0.2 and enough works to judge (>= 5).
      // - No longer drop authors for having no senior authorship; ranking still favors S.
      if (topicWorksCount < 1) return null;
      if (F < 0.2 && (author.works?.length ?? 0) >= 5) return null;

      const S = Math.min(1, seniorAuthorshipRatio);
      const D = topicDominance;
      const P = piScore;

      let finalScore;
      if (clinicalTrialIntent) {
        finalScore =
          0.15 * W + 0.1 * C + 0.1 * R + 0.15 * F + 0.2 * S + 0.1 * D + 0.2 * P;
      } else {
        finalScore =
          0.2 * W +
          0.15 * C +
          0.15 * R +
          0.2 * F +
          0.15 * S +
          0.1 * D +
          0.05 * P;
      }

      if (F < 0.4) finalScore *= 0.7;

      let locationScore = 0;
      if (searchCity && author.institutionNamesLower?.length) {
        const cityMatch = author.institutionNamesLower.some((inst) =>
          inst.includes(searchCity),
        );
        const stateMatch =
          searchState &&
          author.institutionNamesLower.some((inst) =>
            inst.includes(searchState),
          );
        locationScore = cityMatch ? 1.0 : stateMatch ? 0.5 : 0;
      } else if (searchState && searchCountryCode) {
        const stateMatch = author.institutionNamesLower?.some((inst) =>
          inst.includes(searchState),
        );
        const countryMatch =
          (author.countryCodes || []).includes(searchCountryCode) ||
          author.countryCode === searchCountryCode;
        locationScore =
          stateMatch && countryMatch ? 0.6 : countryMatch ? 0.3 : 0;
      } else if (
        searchCountryCode &&
        ((author.countryCodes || []).includes(searchCountryCode) ||
          author.countryCode === searchCountryCode)
      ) {
        locationScore = 0.3;
      }

      return {
        ...author,
        scores: {
          works: W,
          citations: C,
          recency: R,
          fieldRelevance: F,
          seniorAuthorship: S,
          topicDominance: D,
          piScore: P,
          location: locationScore,
          final: finalScore,
        },
      };
    })
    .filter((a) => a !== null)
    .sort((a, b) => {
      const scoreDiff = b.scores.final - a.scores.final;
      if (Math.abs(scoreDiff) > 0.001) return scoreDiff;
      const seniorDiff =
        (b.scores.seniorAuthorship ?? 0) - (a.scores.seniorAuthorship ?? 0);
      if (Math.abs(seniorDiff) > 0.001) return seniorDiff;
      const piDiff = (b.scores.piScore ?? 0) - (a.scores.piScore ?? 0);
      if (Math.abs(piDiff) > 0.001) return piDiff;
      const topicWorksDiff =
        (b.topicWorksCount ?? b.works?.length ?? 0) -
        (a.topicWorksCount ?? a.works?.length ?? 0);
      if (topicWorksDiff !== 0) return topicWorksDiff;
      return (b.scores.location ?? 0) - (a.scores.location ?? 0);
    });

  return rankedAuthors;
}

/**
 * STEP 8: Generate summaries using Gemini (ONLY for UX polish)
 * @param {Array} authors - List of authors to generate summaries for
 * @param {boolean} skipAI - If true, skip AI generation and use simple fallback (for dashboard speed)
 */
async function generateExpertSummaries(authors, skipAI = false) {
  const geminiInstance = getGeminiInstance();

  // Use REAL counts (from OpenAlex author profile) instead of search-result counts
  const getRealPubs = (a) => a.realWorksCount || a.works.length;
  const getRealCitations = (a) => a.realCitationCount || a.totalCitations;

  // For dashboard: skip AI and use simple fallback for speed
  if (skipAI || !geminiInstance) {
    return authors.map((a) => ({
      ...a,
      biography: `Researcher at ${
        a.institutions[0] || "Unknown Institution"
      } with ${getRealPubs(a)} publications and ${getRealCitations(a)} citations.`,
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

      const realPubs = getRealPubs(author);
      const realCitations = getRealCitations(author);

      const prompt = `
Generate a 2-sentence professional biography for this researcher based ONLY on the provided data.

Name: ${author.name}
Institution: ${author.institutions[0] || "Unknown"}
Total Publications: ${realPubs}
Total Citations: ${realCitations}
Recent paper titles:
${recentTitles.map((t, i) => `${i + 1}. ${t}`).join("\n")}

Output only the 2-sentence biography, no additional text. Use the exact publication and citation numbers provided.
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
        400,
      );

      const biography = result.response.text().trim();

      authorsWithSummaries.push({
        ...author,
        biography,
      });
    } catch (error) {
      console.error(
        `Error generating summary for ${author.name}:`,
        error.message,
      );
      // Fallback bio
      authorsWithSummaries.push({
        ...author,
        biography: `Researcher at ${
          author.institutions[0] || "Unknown Institution"
        } with ${getRealPubs(author)} publications and ${getRealCitations(author)} citations.`,
      });
    }
  }

  return authorsWithSummaries;
}

/**
 * STEP 5.5: Fetch real author profiles from OpenAlex to get actual works_count and cited_by_count
 * The works.length from search results only reflects matches in THIS search, not the author's total output
 * @param {Array} authors - Array of author candidates (top N)
 * @returns {Promise<Array>} Authors enriched with real stats
 */
// Only fetch real profiles for top N authors - rest get fallback stats from search results.
// Reduces OpenAlex API calls from 12+ batches to 2 (e.g. 557 → 100 = 2 batches).
const OPENALEX_PROFILE_FETCH_LIMIT = 100;

async function fetchOpenAlexAuthorProfiles(authors, limitProfiles = false) {
  if (!authors || authors.length === 0) return authors;

  // When limitProfiles=true (dashboard), only fetch top N to speed up load. Otherwise fetch all (Experts page).
  const toFetch =
    limitProfiles && authors.length > OPENALEX_PROFILE_FETCH_LIMIT
      ? authors.slice(0, OPENALEX_PROFILE_FETCH_LIMIT)
      : authors;
  if (limitProfiles && authors.length > OPENALEX_PROFILE_FETCH_LIMIT) {
    console.log(
      `[Dashboard] Limiting OpenAlex profile fetch to top ${OPENALEX_PROFILE_FETCH_LIMIT} of ${authors.length} authors`,
    );
  }

  // OpenAlex author IDs look like "https://openalex.org/A1234567890"
  // We need just the ID part for the filter
  const authorIds = Array.from(
    new Set(
      toFetch
        .map((a) => a.id)
        .filter(Boolean)
        .map((id) => {
          // Extract just the OpenAlex ID (e.g., "A1234567890")
          if (id.includes("openalex.org/")) {
            return id.split("openalex.org/")[1];
          }
          return id;
        }),
    ),
  );

  if (authorIds.length === 0) return authors;

  const BATCH_SIZE = 50;
  const allProfiles = [];

  for (let i = 0; i < authorIds.length; i += BATCH_SIZE) {
    const batchIds = authorIds.slice(i, i + BATCH_SIZE);
    const cacheKey = getCacheKey("openalex-authors", batchIds.sort().join(","));
    const cached = getCache(cacheKey);

    let authorProfiles = cached;

    if (!authorProfiles) {
      try {
        // Batch fetch using OpenAlex filter: openalex:A123|A456|A789
        const filterValue = batchIds.join("|");
        const url = "https://api.openalex.org/authors";
        const params = {
          filter: `openalex:${filterValue}`,
          "per-page": batchIds.length,
          select: "id,display_name,works_count,cited_by_count,summary_stats",
          mailto: process.env.OPENALEX_MAILTO || "support@curalink.com",
        };

        console.log(
          `Fetching real profiles for ${batchIds.length} authors from OpenAlex...`,
        );

        const response = await axios.get(url, {
          params,
          headers: {
            "User-Agent":
              "CuraLink/1.0 (expert discovery; mailto:support@curalink.com)",
          },
          timeout: 15000,
        });

        authorProfiles = response.data?.results || [];
        setCache(cacheKey, authorProfiles);
        console.log(`Got real profiles for ${authorProfiles.length} authors`);
      } catch (error) {
        console.error(
          "Error fetching OpenAlex author profiles:",
          error.message,
        );
        authorProfiles = [];
      }
    }

    allProfiles.push(...authorProfiles);
  }

  // Create a lookup map by OpenAlex ID
  const profileMap = new Map();
  for (const profile of allProfiles) {
    profileMap.set(profile.id, profile);
  }

  // Enrich authors with real stats
  return authors.map((author) => {
    const profile = profileMap.get(author.id);
    if (profile) {
      return {
        ...author,
        realWorksCount: profile.works_count || author.works.length,
        realCitationCount: profile.cited_by_count || author.totalCitations,
        hIndex2yr: profile.summary_stats?.["2yr_mean_citedness"] || null,
        iIndex: profile.summary_stats?.i10_index || null,
      };
    }
    // Fallback: use search-result counts (better than nothing)
    return {
      ...author,
      realWorksCount: author.works.length,
      realCitationCount: author.totalCitations,
    };
  });
}

/**
 * Extract country code from location string
 */
function extractCountryCode(location) {
  if (!location) return null;

  const countryMap = {
    canada: "CA",
    "united states": "US",
    usa: "US",
    "u.s.": "US",
    america: "US",
    "united kingdom": "GB",
    uk: "GB",
    england: "GB",
    scotland: "GB",
    wales: "GB",
    germany: "DE",
    france: "FR",
    china: "CN",
    japan: "JP",
    australia: "AU",
    india: "IN",
    brazil: "BR",
    mexico: "MX",
    italy: "IT",
    spain: "ES",
    "south korea": "KR",
    korea: "KR",
    netherlands: "NL",
    holland: "NL",
    sweden: "SE",
    switzerland: "CH",
    norway: "NO",
    denmark: "DK",
    finland: "FI",
    belgium: "BE",
    austria: "AT",
    portugal: "PT",
    ireland: "IE",
    poland: "PL",
    russia: "RU",
    turkey: "TR",
    israel: "IL",
    "saudi arabia": "SA",
    "south africa": "ZA",
    nigeria: "NG",
    egypt: "EG",
    kenya: "KE",
    singapore: "SG",
    malaysia: "MY",
    thailand: "TH",
    indonesia: "ID",
    pakistan: "PK",
    bangladesh: "BD",
    vietnam: "VN",
    philippines: "PH",
    taiwan: "TW",
    "hong kong": "HK",
    "new zealand": "NZ",
    argentina: "AR",
    colombia: "CO",
    chile: "CL",
    peru: "PE",
    "czech republic": "CZ",
    czechia: "CZ",
    romania: "RO",
    hungary: "HU",
    greece: "GR",
    ukraine: "UA",
    iran: "IR",
    iraq: "IQ",
    uae: "AE",
    "united arab emirates": "AE",
    qatar: "QA",
    kuwait: "KW",
  };

  const locationLower = location.toLowerCase();
  const parts = parseLocationParts(location);

  // Prefer last part when "City, State, Country" or "City, Country" format
  if (parts.length >= 2) {
    const lastPart = parts[parts.length - 1].toLowerCase();
    if (countryMap[lastPart]) return countryMap[lastPart];
  }

  // Fallback: check if any part matches a country name
  for (const [country, code] of Object.entries(countryMap)) {
    if (locationLower.includes(country)) {
      return code;
    }
  }

  return null;
}

/**
 * Parse location string into parts: "City, State/Province, Country"
 * @param {string} location - e.g. "Toronto, Ontario, Canada" or "Toronto, Canada" or "Canada"
 */
function parseLocationParts(location) {
  if (!location) return [];
  return location
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Extract city name from location string (City, State/Province, Country format)
 * First part: "Toronto, Ontario, Canada" -> "toronto"
 */
function extractCityName(location) {
  const parts = parseLocationParts(location);
  return parts.length >= 1 ? parts[0].toLowerCase() : null;
}

/**
 * Extract state/province from location string
 * Second part when 3+ parts: "Toronto, Ontario, Canada" -> "ontario"
 */
function extractStateName(location) {
  const parts = parseLocationParts(location);
  return parts.length >= 3 ? parts[1].toLowerCase() : null;
}

/**
 * Check if an author matches the specified location based on their institutions
 * Supports City, State/Province, Country format
 * @param {Object} authorData - Author data with institutions and countryCodes
 * @param {string} location - Location string like "Toronto, Ontario, Canada" or "New Delhi, India"
 * @returns {boolean} True if author matches location
 */
function authorMatchesLocation(authorData, location) {
  if (!location) return true; // No location filter = include all

  const searchCity = extractCityName(location);
  const searchState = extractStateName(location);
  const searchCountryCode = extractCountryCode(location);

  // Check if author has any institution in the specified country
  const hasCountryMatch =
    searchCountryCode &&
    (authorData.countryCodes || []).includes(searchCountryCode);

  // Helper: check if institution names contain a term (city, state, etc.)
  const institutionContains = (term) =>
    authorData.institutionNamesLower &&
    authorData.institutionNamesLower.some((inst) => inst.includes(term));

  // If city is specified, try to match city name in institution
  if (searchCity) {
    // Normalize city name for matching (handle "New Delhi" -> "delhi", "New York" -> "york" or "new york")
    const normalizedCity = searchCity
      .replace(/^(new|old|north|south|east|west)\s+/i, "")
      .trim();

    // Check if any institution name contains the city name (exact or normalized)
    if (
      authorData.institutionNamesLower &&
      authorData.institutionNamesLower.length > 0
    ) {
      const cityMatch = authorData.institutionNamesLower.some((inst) => {
        if (inst.includes(searchCity)) return true;
        if (normalizedCity !== searchCity && inst.includes(normalizedCity))
          return true;
        return false;
      });

      if (cityMatch && hasCountryMatch) {
        return true; // City match + country match = strong match
      }
    }

    // If state/province specified, try state match (e.g., "University of Toronto" + "Ontario")
    if (searchState && institutionContains(searchState) && hasCountryMatch) {
      return true;
    }

    // If city specified but no city match found, still check country
    // This handles cases where institution names don't include city (e.g., "AIIMS" instead of "AIIMS New Delhi")
    if (hasCountryMatch) {
      // Country matches - include but will be ranked lower (handled in ranking function)
      return true;
    }

    // City specified but no city or country match
    return false;
  }

  // Only country specified - check country code match (strict)
  // Check all country codes, not just the primary one
  if (searchCountryCode) {
    return hasCountryMatch;
  }

  // No valid location extracted - include all
  return true;
}

/**
 * MAIN FUNCTION: Deterministic expert discovery with pagination
 * Steps 1-5 (search + rank) are cached so subsequent pages are fast.
 * Only the current page's experts get Gemini summaries (the slow part).
 *
 * @param {string} topic - Research topic
 * @param {string} location - Geographic location (optional)
 * @param {number} page - Page number (1-indexed, default 1)
 * @param {number} pageSize - Results per page (default 5)
 * @param {Object} options - Optional: { limitOpenAlexProfiles: true, skipAISummaries: true } for dashboard (faster)
 * @returns {Promise<Object>} { experts: Array, totalFound: number, page, pageSize, hasMore }
 */
export async function findDeterministicExperts(
  topic,
  location = null,
  page = 1,
  pageSize = 5,
  options = {},
) {
  const { limitOpenAlexProfiles = false, skipAISummaries = false } = options;

  try {
    console.log(
      `🔍 Starting deterministic expert discovery for: ${topic} (page ${page}, pageSize ${pageSize})${limitOpenAlexProfiles ? " [dashboard mode]" : ""}`,
    );

    // --- Cached pipeline: Steps 1-5 run once per query, results are reused for pagination ---
    // Separate cache for dashboard (limited) vs Experts page (full) so both get correct results
    const pipelineCacheKey = getCacheKey(
      "pipeline-ranked",
      topic,
      location || "global",
      limitOpenAlexProfiles ? "limit" : "full",
    );
    let rankedAuthors = getCache(pipelineCacheKey);

    if (!rankedAuthors) {
      // Step 1: Generate search constraints (Gemini for keywords only)
      console.log("Step 1: Generating search constraints...");
      const constraints = await generateSearchConstraints(topic, location);
      console.log(`Generated constraints:`, constraints);

      // Step 2: Search OpenAlex works
      console.log("Step 2: Searching OpenAlex works...");
      const works = await searchOpenAlexWorks(constraints, location);
      console.log(`Found ${works.length} relevant works`);

      if (works.length === 0) {
        return { experts: [], totalFound: 0, page, pageSize, hasMore: false };
      }

      // Step 3: Extract and aggregate authors (with location filtering)
      console.log("Step 3: Extracting and aggregating authors...");
      const authorCandidates = extractAndAggregateAuthors(
        works,
        constraints,
        location,
      );
      console.log(
        `Found ${authorCandidates.length} author candidates${location ? ` (filtered by location: ${location})` : ""}`,
      );

      // Sort by total citations to prioritize top candidates
      authorCandidates.sort((a, b) => b.totalCitations - a.totalCitations);

      // Step 4: Compute field relevance for all authors
      console.log("Step 4: Computing field relevance...");
      authorCandidates.forEach((author) => {
        author.fieldRelevance = computeFieldRelevance(author, constraints);
      });

      // Step 4.5: Fetch REAL publication/citation counts from OpenAlex author profiles
      // (author.works.length is only the count from THIS search, not their total career output)
      // limitOpenAlexProfiles=true for dashboard: fetch top 100 only (faster). Experts page: fetch all.
      console.log("Step 4.5: Fetching real author stats from OpenAlex...");
      const authorCandidatesWithRealStats = await fetchOpenAlexAuthorProfiles(
        authorCandidates,
        limitOpenAlexProfiles,
      );

      // Step 5: Ranking (upgraded formula: senior authorship, topic dominance, PI score; optional trial intent)
      console.log("Step 5: Ranking authors by metrics...");
      rankedAuthors = rankAuthorsByMetrics(
        authorCandidatesWithRealStats,
        location,
        topic,
      );
      console.log(`Ranked ${rankedAuthors.length} authors`);

      // Cache the ranked list so page 2, 3, etc. are instant
      setCache(pipelineCacheKey, rankedAuthors);
    } else {
      console.log(
        `Using cached ranked authors (${rankedAuthors.length} total)`,
      );
    }

    // --- Pagination: slice for current page ---
    const totalFound = rankedAuthors.length;
    const startIdx = (page - 1) * pageSize;
    const endIdx = startIdx + pageSize;
    const pageAuthors = rankedAuthors.slice(startIdx, endIdx);
    const hasMore = endIdx < totalFound;

    if (pageAuthors.length === 0) {
      return { experts: [], totalFound, page, pageSize, hasMore: false };
    }

    // Step 6: Generate summaries (Gemini for UX only) - ONLY for this page
    // For dashboard: skip AI summaries for faster load (use simple fallback)
    if (skipAISummaries) {
      console.log(
        `Step 6: Skipping AI summaries for ${pageAuthors.length} experts (dashboard mode)...`,
      );
    } else {
      console.log(
        `Step 6: Generating summaries for ${pageAuthors.length} experts (page ${page})...`,
      );
    }
    const expertsWithSummaries = await generateExpertSummaries(
      pageAuthors,
      skipAISummaries,
    );

    console.log(
      `✅ Returning ${expertsWithSummaries.length} experts (page ${page}/${Math.ceil(totalFound / pageSize)})`,
    );
    return {
      experts: expertsWithSummaries,
      totalFound,
      page,
      pageSize,
      hasMore,
    };
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
    location: expert.countryCode ? `${expert.countryCode}` : null,
    biography: expert.biography || null,
    orcid: expert.orcid || null,
    orcidUrl: expert.orcid ? `https://orcid.org/${expert.orcid}` : null,

    // Metrics - use REAL counts from OpenAlex author profile (not search-result counts)
    metrics: {
      totalPublications: expert.realWorksCount || expert.works.length,
      totalCitations: expert.realCitationCount || expert.totalCitations,
      recentPublications: expert.recentWorks,
      lastAuthorCount: expert.lastAuthorCount,
      firstAuthorCount: expert.firstAuthorCount,
      correspondingAuthorCount: expert.correspondingAuthorCount ?? null,
      topicWorksCount: expert.topicWorksCount ?? expert.works?.length,
      topicCitationCount: expert.topicCitationCount ?? null,
      trialWorkCount: expert.trialWorkCount ?? null,
      trialLastAuthorCount: expert.trialLastAuthorCount ?? null,
      hIndex: expert.semanticScholar?.hIndex || null,
      iIndex: expert.iIndex || null,
      fieldRelevance: Math.round((expert.fieldRelevance ?? 0) * 100),
      topicSpecificWorks: expert.works?.length ?? 0,
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
