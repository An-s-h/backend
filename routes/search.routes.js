import { Router } from "express";
import { searchClinicalTrials } from "../services/clinicalTrials.service.js";
import { searchPubMed } from "../services/pubmed.service.js";
import { searchORCID } from "../services/orcid.service.js";
import { findResearchersWithGemini } from "../services/geminiExperts.service.js";
import { searchGoogleScholarPublications } from "../services/googleScholar.service.js";
import { getExpertProfile } from "../services/expertProfile.service.js";
import { searchVerifiedExpertsV2 } from "../services/expertDiscoveryV2.service.js";
import {
  findDeterministicExperts,
  formatExpertsForResponse,
} from "../services/deterministicExperts.service.js";
import {
  fetchTrialById,
  fetchPublicationById,
} from "../services/urlParser.service.js";
import {
  simplifyTrialDetails,
  simplifyTrialTitle,
  batchSimplifyTrialTitles,
} from "../services/trialSimplification.service.js";
import {
  simplifyPublicationDetails,
  simplifyPublicationTitle,
} from "../services/publicationSimplification.service.js";
import { batchSimplifyPublicationTitles } from "../services/summary.service.js";
import { ReadItem } from "../models/ReadItem.js";
import {
  calculateTrialMatch,
  calculatePublicationMatch,
  calculateExpertMatch,
} from "../services/matching.service.js";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { parseQuery } from "../utils/queryParser.js";
import {
  extractBiomarkers,
  expandQueryWithSynonyms,
  mapToMeSHTerminology,
} from "../services/medicalTerminology.service.js";

// Browser-based search limit system (strict 6 searches per device/browser)
// Uses deviceId from localStorage (survives IP changes, proxies, browser restarts)
import {
  checkSearchLimit,
  incrementSearchCount,
  getSearchLimitDebug,
  MAX_FREE_SEARCHES,
} from "../middleware/searchLimit.js";

const router = Router();

const PUBLICATION_STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
]);

function tokenizeForRelevance(text = "") {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !PUBLICATION_STOP_WORDS.has(term));
}

function buildATMQuery(rawQuery = "") {
  const hasFieldTags = /\[[A-Za-z]{2,}\]/.test(rawQuery || "");
  const parsedQuery = rawQuery ? parseQuery(rawQuery) : "";
  const atmParts = [];

  if (rawQuery && !hasFieldTags) {
    const meshMapped = mapToMeSHTerminology(rawQuery);
    const synonymExpanded = expandQueryWithSynonyms(rawQuery);

    if (meshMapped && meshMapped !== rawQuery) {
      atmParts.push(`${meshMapped} [MH]`);
    }
    if (synonymExpanded && synonymExpanded !== rawQuery) {
      atmParts.push(synonymExpanded);
    }
  }

  const atmQuery =
    atmParts.length > 0
      ? [parsedQuery || rawQuery, ...atmParts]
          .filter(Boolean)
          .map((p) => `(${p})`)
          .join(" OR ")
      : parsedQuery || rawQuery;

  // Build a term list for relevance scoring
  // Only use original query terms (not expanded synonyms) for relevance scoring
  // This matches trials backend approach - we want to score against what user actually typed
  const queryTerms = tokenizeForRelevance(rawQuery);

  return {
    pubmedQuery: atmQuery,
    queryTerms: queryTerms,
    rawQueryLower: (rawQuery || "").toLowerCase().trim(),
    hasFieldTags,
  };
}

function countTermHits(term, text = "") {
  if (!term || !text) return 0;
  const safe = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`\\b${safe}\\b`, "gi");
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

function calculatePublicationRelevanceSignals(pub, queryMeta) {
  if (!queryMeta?.queryTerms?.length) {
    return {
      queryRelevanceScore: 0,
      queryMatchCount: 0,
      queryTermCount: 0,
      significantTermMatches: 0,
      recencyWeight: 0,
      hasNctLink: false,
    };
  }

  const title = (pub.title || "").toLowerCase();
  const abstract = (pub.abstract || "").toLowerCase();
  const keywords = Array.isArray(pub.keywords)
    ? pub.keywords.join(" ").toLowerCase()
    : "";
  const searchText = `${title} ${abstract} ${keywords}`;

  const hasNctLink =
    /nct\d{8}/i.test(pub.abstract || "") ||
    /nct\d{8}/i.test(pub.title || "") ||
    /nct\d{8}/i.test(keywords);

  const nowYear = new Date().getFullYear();
  const pubYear = parseInt(pub.year, 10);
  const yearsOld =
    Number.isInteger(pubYear) && pubYear > 1800 ? nowYear - pubYear : null;
  const recencyWeight =
    yearsOld === null
      ? 0.2
      : yearsOld <= 2
        ? 1
        : yearsOld <= 5
          ? 0.7
          : yearsOld <= 10
            ? 0.4
            : 0.15;

  // Check for exact phrase match first (highest priority) - like trials backend
  const exactPhraseMatch =
    queryMeta.rawQueryLower && searchText.includes(queryMeta.rawQueryLower);

  let matchCount = 0;
  let significantTermMatches = 0;

  if (exactPhraseMatch) {
    // If exact phrase matches, count all terms as matched
    matchCount = queryMeta.queryTerms.length;
    significantTermMatches = queryMeta.queryTerms.length;
  } else {
    // Use word boundaries for more precise matching to avoid false positives
    // Match trials backend approach exactly
    for (const term of queryMeta.queryTerms) {
      // Use word boundary regex to match whole words only
      const termRegex = new RegExp(
        `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "i",
      );
      if (termRegex.test(searchText)) {
        matchCount++;
        // Consider it significant if it appears in title or keywords (not just abstract)
        if (termRegex.test(title) || termRegex.test(keywords)) {
          significantTermMatches++;
        }
      }
    }
  }

  const termCount = queryMeta.queryTerms.length;

  // Calculate relevance score with stricter weighting (matching trials backend):
  // - Exact phrase match = 1.0 (perfect match)
  // - All terms match in title/keywords = 0.95+ (high relevance)
  // - Most terms match in title/keywords = 0.85+ (good relevance)
  // - All terms match but only in abstract = 0.5-0.7 (lower relevance - may be false positive)
  // - Partial matches = much lower scores
  let queryRelevanceScore = 0;
  if (exactPhraseMatch) {
    queryRelevanceScore = 1.0;
  } else if (termCount > 0) {
    const allTermsMatch = matchCount === termCount;
    const significantRatio = significantTermMatches / termCount;
    const matchRatio = matchCount / termCount;

    if (allTermsMatch && significantRatio >= 0.6) {
      // All terms matched and at least 60% are in title/keywords - very relevant
      queryRelevanceScore = 0.85 + significantRatio * 0.15; // 0.94 - 1.0
    } else if (allTermsMatch && significantRatio >= 0.4) {
      // All terms matched and at least 40% in title/keywords - good relevance
      queryRelevanceScore = 0.75 + significantRatio * 0.1; // 0.79 - 0.85
    } else if (allTermsMatch && significantRatio > 0) {
      // All terms matched but mostly in abstract - moderate relevance (may filter later)
      queryRelevanceScore = 0.5 + significantRatio * 0.2; // 0.5 - 0.7
    } else if (allTermsMatch) {
      // All terms matched but NONE in title/keywords - likely false positive
      queryRelevanceScore = 0.3; // Very low score
    } else if (matchRatio >= 0.75) {
      // Most terms (75%+) matched
      queryRelevanceScore = 0.5 + significantRatio * 0.3; // 0.5 - 0.8
    } else if (matchRatio >= 0.5) {
      // Half or more terms matched
      queryRelevanceScore = 0.3 + significantRatio * 0.3; // 0.3 - 0.6
    } else {
      // Less than half matched - low relevance
      queryRelevanceScore = matchRatio * 0.5; // 0.0 - 0.25
    }

    // Add small boosts for recency and NCT linkage (but don't override strict relevance)
    if (queryRelevanceScore >= 0.5) {
      // Only boost if already relevant
      const recencyBoost = recencyWeight * 0.05; // Small boost for recent papers
      const nctBoost = hasNctLink ? 0.05 : 0; // Small boost for NCT linkage
      queryRelevanceScore = Math.min(
        1.0,
        queryRelevanceScore + recencyBoost + nctBoost,
      );
    }
  }

  return {
    queryRelevanceScore,
    queryMatchCount: matchCount,
    queryTermCount: termCount,
    significantTermMatches,
    recencyWeight,
    hasNctLink,
  };
}

router.get("/search/trials", async (req, res) => {
  try {
    // Check search limit for anonymous users (browser-based deviceId)
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      if (!limitCheck.canSearch) {
        return res.status(429).json({
          error:
            limitCheck.message ||
            "You've used all your free searches! Sign in to continue searching.",
          remaining: 0,
          results: [],
          showSignUpPrompt: limitCheck.showSignUpPrompt,
        });
      }
    }

    const {
      q,
      status,
      location,
      phase,
      userId,
      conditions,
      keywords,
      userLocation,
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
      page = "1",
      pageSize = "9",
      recentMonths,
      sortByDate,
    } = req.query;

    // Layer 3: Extract biomarkers from conditions/keywords if provided
    // Only extract if conditions are actually provided (medical interests enabled)
    let biomarkers = [];

    // Extract biomarkers from query params (for non-signed-in users)
    if (conditions) {
      const conditionsStr = Array.isArray(conditions)
        ? conditions.join(" ")
        : conditions;
      const conditionBiomarkers = extractBiomarkers(conditionsStr);
      biomarkers = [...biomarkers, ...conditionBiomarkers];
    }
    if (keywords) {
      const keywordsStr = Array.isArray(keywords)
        ? keywords.join(" ")
        : keywords;
      const keywordBiomarkers = extractBiomarkers(keywordsStr);
      biomarkers = [...biomarkers, ...keywordBiomarkers];
    }

    // Extract biomarkers from user profile if userId is provided (signed-in users)
    // We'll fetch the profile here and reuse it later for matching
    let userProfile = null;
    if (userId) {
      userProfile = await Profile.findOne({ userId }).lean();
      if (userProfile) {
        const profileConditions = userProfile.patient?.conditions || [];
        const profileKeywords = userProfile.patient?.keywords || [];
        const profileConditionsStr = profileConditions.join(" ");
        const profileKeywordsStr = profileKeywords.join(" ");

        if (profileConditionsStr) {
          const profileBiomarkers = extractBiomarkers(profileConditionsStr);
          biomarkers = [...biomarkers, ...profileBiomarkers];
        }
        if (profileKeywordsStr) {
          const profileKeywordBiomarkers =
            extractBiomarkers(profileKeywordsStr);
          biomarkers = [...biomarkers, ...profileKeywordBiomarkers];
        }
      }
    }

    // Remove duplicates
    biomarkers = [...new Set(biomarkers)];

    // Fetch a larger batch to sort by match percentage before pagination
    // This ensures results are sorted across all pages, not just within each page
    const requestedPage = parseInt(page, 10);
    const requestedPageSize = parseInt(pageSize, 10);
    // Fetch up to 500 results for sorting (covers ~83 pages with 6 results per page)
    const batchSize = Math.min(500, Math.max(100, requestedPageSize * 50));

    const result = await searchClinicalTrials({
      q,
      status,
      location,
      phase,
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
      biomarkers, // Layer 3: Pass extracted biomarkers
      page: 1, // Always fetch from page 1 for the batch
      pageSize: batchSize, // Fetch larger batch for sorting
      recentMonths: recentMonths ? parseInt(recentMonths, 10) : undefined,
      sortByDate: sortByDate === "true" || sortByDate === true,
    });
    const allResults = result.items || [];

    // Build user profile for matching (reuse if already fetched for biomarkers)
    if (!userProfile) {
      if (userId) {
        // Fetch user profile from database (shouldn't happen if biomarkers extraction already fetched it)
        userProfile = await Profile.findOne({ userId }).lean();
      } else if (conditions || keywords || userLocation) {
        // Build profile from query params
        const locationObj = userLocation
          ? typeof userLocation === "string"
            ? JSON.parse(userLocation)
            : userLocation
          : null;
        userProfile = {
          patient: {
            conditions: conditions
              ? Array.isArray(conditions)
                ? conditions
                : [conditions]
              : [],
            keywords: keywords
              ? Array.isArray(keywords)
                ? keywords
                : [keywords]
              : [],
            location: locationObj,
          },
        };
      }
    }

    // Calculate match percentages if user profile is available
    const resultsWithMatch = userProfile
      ? allResults.map((trial) => {
          const match = calculateTrialMatch(trial, userProfile);
          return {
            ...trial,
            matchPercentage: match.matchPercentage,
            matchExplanation: match.matchExplanation,
          };
        })
      : allResults;

    // Sort by match percentage (descending - highest first) before pagination
    const sortedResults = resultsWithMatch.sort(
      (a, b) => (b.matchPercentage || -1) - (a.matchPercentage || -1),
    );

    // Paginate FIRST, then simplify only the titles that will be shown to the user
    // This is much faster than simplifying all trials in the batch
    const startIndex = (requestedPage - 1) * requestedPageSize;
    const endIndex = startIndex + requestedPageSize;
    const paginatedResults = sortedResults.slice(startIndex, endIndex);

    // Simplify titles only for the paginated results (much faster!)
    // This adds simplified titles to each trial object
    let resultsWithSimplifiedTitles;
    try {
      // Use batch processing for much better performance - only for paginated results
      const simplifiedTitles = await batchSimplifyTrialTitles(paginatedResults);
      resultsWithSimplifiedTitles = paginatedResults.map((trial, index) => ({
        ...trial,
        simplifiedTitle: simplifiedTitles[index] || trial.title,
      }));
    } catch (error) {
      // If batch simplification fails, fallback to original titles
      console.error("Error batch simplifying titles:", error);
      resultsWithSimplifiedTitles = paginatedResults.map((trial) => ({
        ...trial,
        simplifiedTitle: trial.title,
      }));
    }

    // Add read status for signed-in users (only for paginated results to reduce DB queries)
    let resultsWithReadStatus = resultsWithSimplifiedTitles;
    if (req.user && req.user._id) {
      const trialIds = resultsWithSimplifiedTitles
        .map((t) => t.id || t._id)
        .filter(Boolean);
      if (trialIds.length > 0) {
        const readItems = await ReadItem.find({
          userId: req.user._id,
          type: "trial",
          itemId: { $in: trialIds },
        }).select("itemId");

        const readItemIds = new Set(readItems.map((r) => r.itemId));
        resultsWithReadStatus = resultsWithSimplifiedTitles.map((trial) => ({
          ...trial,
          isRead: readItemIds.has(trial.id || trial._id),
        }));
      }
    }

    // Increment search count for anonymous users only after results are successfully loaded and processed
    if (!req.user) {
      await incrementSearchCount(req);
    }

    // Get remaining searches for anonymous users
    let remaining = null;
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      remaining = limitCheck.remaining;
    }

    // Calculate if there are more results
    // Note: We're only showing results from the batch we fetched, so hasMore is based on batch size
    const hasMore = endIndex < sortedResults.length;

    res.json({
      results: resultsWithReadStatus,
      totalCount: Math.min(result.totalCount || 0, sortedResults.length), // Use batch size as total count for pagination purposes
      hasMore: hasMore,
      ...(remaining !== null && { remaining }),
    });
  } catch (error) {
    console.error("Error searching trials:", error);
    res.status(500).json({ error: "Failed to search trials", results: [] });
  }
});

router.get("/search/publications", async (req, res) => {
  try {
    // Check search limit for anonymous users (browser-based deviceId)
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      if (!limitCheck.canSearch) {
        return res.status(429).json({
          error:
            limitCheck.message ||
            "You've used all your free searches! Sign in to continue searching.",
          remaining: 0,
          results: [],
          showSignUpPrompt: limitCheck.showSignUpPrompt,
        });
      }
    }

    const {
      q,
      location,
      userId,
      conditions,
      keywords,
      userLocation,
      mindate,
      maxdate,
      page = "1",
      pageSize = "9",
      recentMonths,
      sortByDate,
    } = req.query;

    // Log incoming search parameters for debugging
    console.log("Publications search params:", {
      q,
      location,
      mindate,
      maxdate,
      page,
      pageSize,
    });

    // Check if query is a PMC ID (e.g., "PMC3344234" or "3344234")
    const pmcIdMatch = q?.match(/^(PMC)?(\d{7,8})$/i);
    // Check if query is a PMID (PubMed ID) - typically 8 digits without PMC prefix
    const pmidMatch = q?.match(/^(\d{7,8})$/);
    let pubmedQuery = "";
    let atmQueryMeta = null;

    if (pmcIdMatch && pmcIdMatch[1]) {
      // PMC ID search with PMC prefix - use exact PMC ID field tag
      const pmcId = q;
      pubmedQuery = `${pmcId}[PMCID]`;
      console.log("PMC ID search detected:", pmcId);
      atmQueryMeta = {
        pubmedQuery,
        queryTerms: [],
        rawQueryLower: (q || "").toLowerCase().trim(),
        hasFieldTags: true,
        isPmcSearch: true,
      };
    } else if (pmidMatch) {
      // PMID search (just numbers, could be PMID or PMC without prefix)
      // Try both PMID and PMCID for better coverage
      const numericId = pmidMatch[1];
      pubmedQuery = `${numericId}[PMID] OR PMC${numericId}[PMCID]`;
      console.log("PMID/PMC numeric search detected:", numericId);
      atmQueryMeta = {
        pubmedQuery,
        queryTerms: [],
        rawQueryLower: (q || "").toLowerCase().trim(),
        hasFieldTags: true,
        isPmidSearch: true,
      };
    } else if (q && q.length > 30) {
      // Long query likely to be an exact title - search in title field
      // PubMed's exact phrase matching with "phrase"[Title] FAILS on special characters
      // like apostrophes, colons, periods, etc. (returns 0 results).
      // Instead, split into significant words and AND them together with [ti] field tags.
      // e.g. "Oncology's trial and error: Analysis" → Oncology[ti] AND trial[ti] AND error[ti] AND Analysis[ti]
      const titleStopWords = new Set([
        "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
        "of", "with", "by", "is", "are", "was", "were", "be", "been", "its",
        "it", "as", "from", "that", "this", "than", "into", "not", "no",
      ]);
      const titleWords = q
        .replace(/[^\w\s-]/g, " ")  // Strip punctuation (apostrophes, colons, periods, etc.)
        .split(/\s+/)
        .map((w) => w.trim())
        .filter((w) => w.length >= 2 && !titleStopWords.has(w.toLowerCase()));

      if (titleWords.length > 0) {
        // Use each significant word with [ti] joined by AND for precise title matching
        pubmedQuery = titleWords.map((w) => `${w}[ti]`).join(" AND ");
      } else {
        // Fallback: just use the raw query
        pubmedQuery = q;
      }
      console.log("Exact title search detected:", pubmedQuery);
      atmQueryMeta = {
        pubmedQuery,
        queryTerms: tokenizeForRelevance(q),
        rawQueryLower: (q || "").toLowerCase().trim(),
        hasFieldTags: true,
        isExactTitleSearch: true,
      };
    } else {
      // Build query with ATM-style expansion (MeSH + synonyms) unless user forces field tags
      atmQueryMeta = buildATMQuery(q || "");
      pubmedQuery = atmQueryMeta.pubmedQuery;
    }

    // Add location (country) to query if provided and not already in advanced query
    if (location && !atmQueryMeta.hasFieldTags) {
      // Only add location if it's a simple query (not advanced search with field tags)
      pubmedQuery = `${pubmedQuery} ${location}`.trim();
    }

    // Calculate mindate from recentMonths if provided (overrides explicit mindate)
    let effectiveMindate = mindate || "";
    if (recentMonths && Number.isInteger(parseInt(recentMonths, 10))) {
      const months = parseInt(recentMonths, 10);
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - months);
      const year = cutoff.getFullYear();
      const month = String(cutoff.getMonth() + 1).padStart(2, "0");
      effectiveMindate = `${year}/${month}`;
    }

    // Fetch a larger batch to sort by match percentage before pagination
    // This ensures results are sorted across all pages, not just within each page
    const requestedPage = parseInt(page, 10);
    const requestedPageSize = parseInt(pageSize, 10);
    const batchSize = Math.min(500, Math.max(100, requestedPageSize * 50));

    const pubmedResult = await searchPubMed({
      q: pubmedQuery,
      mindate: effectiveMindate,
      maxdate: maxdate || "",
      page: 1, // Always fetch from page 1 for the batch
      pageSize: batchSize, // Fetch larger batch for sorting
      sort: sortByDate === "true" || sortByDate === true ? "date" : "relevance",
      // Skip query parsing for PMC ID, PMID, and exact title searches
      // to preserve the field tags we've carefully crafted
      skipParsing: atmQueryMeta.isPmcSearch || atmQueryMeta.isPmidSearch || atmQueryMeta.isExactTitleSearch,
    });

    console.log(
      "PubMed result count:",
      pubmedResult.totalCount,
      "items fetched:",
      pubmedResult.items?.length,
    );

    // Filter out publications without abstracts (but not for exact searches -
    // when user searches by title/ID they want that specific publication regardless)
    const allResults = (atmQueryMeta.isExactTitleSearch || atmQueryMeta.isPmcSearch || atmQueryMeta.isPmidSearch)
      ? (pubmedResult.items || [])
      : (pubmedResult.items || []).filter(
          (pub) => pub.abstract && pub.abstract.trim().length > 0,
        );

    // Build user profile for matching
    let userProfile = null;
    if (userId) {
      // Fetch user profile from database
      const profile = await Profile.findOne({ userId }).lean();
      if (profile) {
        userProfile = { ...profile };
      }
    } else if (conditions || keywords || userLocation) {
      // Build profile from query params
      const locationObj = userLocation
        ? typeof userLocation === "string"
          ? JSON.parse(userLocation)
          : userLocation
        : null;
      userProfile = {
        patient: {
          conditions: conditions
            ? Array.isArray(conditions)
              ? conditions
              : [conditions]
            : [],
          keywords: keywords
            ? Array.isArray(keywords)
              ? keywords
              : [keywords]
            : [],
          location: locationObj,
        },
      };
    }

    // Always include search query terms in match calculation - publications matching
    // the user's search should show high match % (e.g. searching "Diabetes" -> Diabetes papers = high match)
    let queryTermsForMatch = atmQueryMeta?.queryTerms || [];
    if (queryTermsForMatch.length === 0 && q && q.trim()) {
      // Fallback for short queries (e.g. "AI", "MS") that tokenize to empty
      queryTermsForMatch = q
        .trim()
        .split(/\s+/)
        .filter((t) => t.length >= 2);
    }
    if (queryTermsForMatch.length > 0) {
      if (!userProfile) {
        userProfile = { patient: {} };
      }
      if (!userProfile.patient) userProfile.patient = {};
      const existing = userProfile.patient.keywords || [];
      userProfile.patient.keywords = [
        ...new Set([...queryTermsForMatch, ...existing]),
      ];
    }

    // Calculate match percentages (always run when we have terms to match - profile or search query)
    const resultsWithMatch = userProfile
      ? allResults.map((publication) => {
          const match = calculatePublicationMatch(publication, userProfile);
          return {
            ...publication,
            matchPercentage: match.matchPercentage,
            matchExplanation: match.matchExplanation,
          };
        })
      : allResults;

    // Calculate query relevance score for each publication (PRIMARY ranking factor)
    // This ensures results match what the user actually searched for (matching trials backend)
    let scoredResults;
    if (q) {
      scoredResults = resultsWithMatch.map((publication) => {
        // For PMC ID, PMID, or exact title searches, give perfect relevance score
        if (atmQueryMeta.isPmcSearch || atmQueryMeta.isPmidSearch || atmQueryMeta.isExactTitleSearch) {
          return {
            ...publication,
            queryRelevanceScore: 1.0, // Perfect match
            queryMatchCount: 1,
            queryTermCount: 1,
            significantTermMatches: 1,
            recencyWeight: 0,
            hasNctLink: false,
          };
        }
        
        // Normal relevance calculation for regular searches
        const signals = calculatePublicationRelevanceSignals(
          publication,
          atmQueryMeta,
        );
        return { ...publication, ...signals };
      });
    } else {
      // If no query, set relevance to 0 (will be sorted by other factors)
      scoredResults = resultsWithMatch.map((publication) => ({
        ...publication,
        queryRelevanceScore: 0,
        queryMatchCount: 0,
        queryTermCount: 0,
        significantTermMatches: 0,
        recencyWeight: 0,
        hasNctLink: false,
      }));
    }

    // Filter out results with very low query relevance (likely false positives)
    // Use 0.25 threshold to keep more relevant results (PubMed shows more; we were too aggressive at 0.5)
    // Skip filtering for PMC ID, PMID, and exact title searches (we want all results)
    if (q && !atmQueryMeta.isPmcSearch && !atmQueryMeta.isPmidSearch && !atmQueryMeta.isExactTitleSearch) {
      scoredResults = scoredResults.filter((publication) => {
        const relevance = publication.queryRelevanceScore || 0;
        // Keep if: exact phrase match (1.0), or relevance >= 0.25 (relaxed for more PubMed-like results)
        return relevance >= 0.25 || relevance === 1.0;
      });
    }

    // Layer 5: Rank by match percentage FIRST (like trials), then query relevance, then other factors
    // User expects highest match % first - all 97% before 81%, etc. (fixes duplicate match % on different pages)
    const sortedResults = scoredResults.sort((a, b) => {
      // First: Profile match percentage (PRIMARY - user expects this like trials)
      const aMatch = a.matchPercentage ?? -1;
      const bMatch = b.matchPercentage ?? -1;
      if (bMatch !== aMatch) return bMatch - aMatch;

      // Second: Query relevance (tiebreaker)
      const aQuery = a.queryRelevanceScore || 0;
      const bQuery = b.queryRelevanceScore || 0;
      if (Math.abs(bQuery - aQuery) > 0.05) return bQuery - aQuery;

      // Third: NCT linkage (boost for publications linking to clinical trials)
      const aNct = a.hasNctLink ? 1 : 0;
      const bNct = b.hasNctLink ? 1 : 0;
      if (bNct !== aNct) return bNct - aNct;

      // Fourth: Recency (recent publications get slight boost)
      const aRecency = a.recencyWeight || 0;
      const bRecency = b.recencyWeight || 0;
      return (bRecency || 0) - (aRecency || 0);
    });

    // Paginate FIRST, then simplify only the titles that will be shown to the user
    // This is much faster than simplifying all publications in the batch
    const startIndex = (requestedPage - 1) * requestedPageSize;
    const endIndex = startIndex + requestedPageSize;
    const paginatedResults = sortedResults.slice(startIndex, endIndex);

    // Simplify titles only for the paginated results (much faster!)
    // This adds simplified titles to each publication object
    let resultsWithSimplifiedTitles;
    try {
      // Use batch processing for much better performance - only for paginated results
      const titlesToSimplify = paginatedResults.map((pub) => pub.title);
      const simplifiedTitles =
        await batchSimplifyPublicationTitles(titlesToSimplify);
      resultsWithSimplifiedTitles = paginatedResults.map(
        (publication, index) => ({
          ...publication,
          simplifiedTitle: simplifiedTitles[index] || publication.title,
        }),
      );
    } catch (error) {
      // If batch simplification fails, fallback to original titles
      console.error("Error batch simplifying publication titles:", error);
      resultsWithSimplifiedTitles = paginatedResults.map((publication) => ({
        ...publication,
        simplifiedTitle: publication.title,
      }));
    }

    // Add read status for signed-in users (only for paginated results to reduce DB queries)
    let resultsWithReadStatus = resultsWithSimplifiedTitles;
    if (req.user && req.user._id) {
      const publicationIds = resultsWithSimplifiedTitles
        .map((p) => p.pmid || p.id || p._id)
        .filter(Boolean);
      if (publicationIds.length > 0) {
        const readItems = await ReadItem.find({
          userId: req.user._id,
          type: "publication",
          itemId: { $in: publicationIds.map(String) },
        }).select("itemId");

        const readItemIds = new Set(readItems.map((r) => r.itemId));
        resultsWithReadStatus = resultsWithSimplifiedTitles.map(
          (publication) => ({
            ...publication,
            isRead: readItemIds.has(
              String(publication.pmid || publication.id || publication._id),
            ),
          }),
        );
      }
    }

    // Increment search count for anonymous users only after results are successfully loaded and processed
    if (!req.user) {
      await incrementSearchCount(req);
    }

    // Get remaining searches for anonymous users
    let remaining = null;
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      remaining = limitCheck.remaining;
    }

    // Calculate if there are more results
    // Note: We're only showing results from the batch we fetched, so hasMore is based on batch size
    const hasMore = endIndex < sortedResults.length;

    res.json({
      results: resultsWithReadStatus,
      totalCount: Math.min(pubmedResult.totalCount || 0, sortedResults.length), // Use batch size as total count for pagination purposes
      page: requestedPage,
      pageSize: requestedPageSize,
      hasMore: hasMore,
      ...(remaining !== null && { remaining }),
    });
  } catch (error) {
    console.error("Error searching publications:", error);
    res.status(500).json({
      error: "Failed to search publications",
      results: [],
      totalCount: 0,
      hasMore: false,
    });
  }
});

router.get("/search/experts", async (req, res) => {
  try {
    // Check search limit for anonymous users (browser-based deviceId)
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      if (!limitCheck.canSearch) {
        return res.status(429).json({
          error:
            limitCheck.message ||
            "You've used all your free searches! Sign in to continue searching.",
          remaining: 0,
          results: [],
          showSignUpPrompt: limitCheck.showSignUpPrompt,
        });
      }
    }

    const {
      q = "",
      location,
      userId,
      conditions,
      keywords,
      userLocation,
    } = req.query;

    if (!q || !q.trim()) {
      return res.json({ results: [] });
    }

    // Parse query to extract research area and disease interest
    // Format from frontend: "researchArea in diseaseOfInterest" or "researchArea" or "diseaseOfInterest"
    // Location is passed separately as a query parameter, not in the query string
    let researchArea = null;
    let diseaseInterest = null;
    const queryTrimmed = q.trim();
    const queryLower = queryTrimmed.toLowerCase();

    // Check if query contains " in " pattern (case insensitive)
    if (queryLower.includes(" in ")) {
      // Split by " in " but preserve the original case
      const parts = queryTrimmed.split(/\s+in\s+/i);
      if (parts.length >= 2) {
        researchArea = parts[0].trim();
        // The disease interest is everything after the first "in"
        // Remove location patterns if they exist (city, country at the end)
        let remaining = parts.slice(1).join(" in ").trim();
        // Remove common location patterns (e.g., "Toronto, Canada", "New York, USA")
        const locationPattern = /,\s*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*$/;
        remaining = remaining.replace(locationPattern, "").trim();
        // Also remove "global" if present
        remaining = remaining.replace(/\s+global\s*$/i, "").trim();
        diseaseInterest = remaining || null;
      } else {
        researchArea = parts[0].trim();
      }
    } else {
      // Single term - could be either research area or disease
      // We'll treat it as both for matching purposes
      researchArea = queryTrimmed;
      diseaseInterest = queryTrimmed;
    }

    // Build query with location if provided (e.g., "oncology in Toronto, Canada")
    let expertsQuery = q.trim();
    if (location) {
      expertsQuery = `${q.trim()} in ${location}`;
    } else {
      expertsQuery = `${q.trim()} global`;
    }

    // Use Gemini to find researchers based on the search query
    const experts = await findResearchersWithGemini(expertsQuery);

    // Increment search count for anonymous users after successful search
    if (!req.user) {
      await incrementSearchCount(req);
    }

    // If no experts found and it might be due to overload, return a helpful message
    if (experts.length === 0) {
      return res.json({
        results: [],
        message:
          "No experts found. The AI service may be temporarily unavailable. Please try again in a moment.",
      });
    }

    // Build user profile for matching
    let userProfile = null;
    if (userId) {
      // Fetch user profile from database
      const profile = await Profile.findOne({ userId }).lean();
      if (profile) {
        userProfile = profile;
      }
    } else if (conditions || keywords || userLocation) {
      // Build profile from query params
      const locationObj = userLocation
        ? typeof userLocation === "string"
          ? JSON.parse(userLocation)
          : userLocation
        : null;
      userProfile = {
        patient: {
          conditions: conditions
            ? Array.isArray(conditions)
              ? conditions
              : [conditions]
            : [],
          keywords: keywords
            ? Array.isArray(keywords)
              ? keywords
              : [keywords]
            : [],
          location: locationObj,
        },
      };
    }

    // Add research area and disease interest to user profile for enhanced matching
    if (researchArea || diseaseInterest) {
      if (!userProfile) {
        userProfile = { patient: {} };
      }
      if (!userProfile.patient) {
        userProfile.patient = {};
      }

      // Add research area as a keyword/condition
      if (researchArea) {
        if (!userProfile.patient.keywords) {
          userProfile.patient.keywords = [];
        }
        if (!userProfile.patient.keywords.includes(researchArea)) {
          userProfile.patient.keywords.push(researchArea);
        }
      }

      // Add disease interest as a condition
      if (diseaseInterest && diseaseInterest !== researchArea) {
        if (!userProfile.patient.conditions) {
          userProfile.patient.conditions = [];
        }
        if (!userProfile.patient.conditions.includes(diseaseInterest)) {
          userProfile.patient.conditions.push(diseaseInterest);
        }
      }

      // Store flags to indicate we have both research area and disease interest
      userProfile.hasResearchArea = !!researchArea;
      userProfile.hasDiseaseInterest = !!diseaseInterest;
      userProfile.researchArea = researchArea;
      userProfile.diseaseInterest = diseaseInterest;
    }

    // Calculate match percentages if user profile is available
    const resultsWithMatch = userProfile
      ? experts.map((expert) => {
          const match = calculateExpertMatch(expert, userProfile);
          return {
            ...expert,
            matchPercentage: match.matchPercentage,
            matchExplanation: match.matchExplanation,
          };
        })
      : experts;

    // Get remaining searches for anonymous users
    let remaining = null;
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      remaining = limitCheck.remaining;
    }

    res.json({
      results: resultsWithMatch,
      ...(remaining !== null && { remaining }),
    });
  } catch (error) {
    console.error("Error searching experts:", error);

    // Check if it's an overload error
    if (
      error.message?.includes("overloaded") ||
      error.message?.includes("503")
    ) {
      return res.status(503).json({
        error:
          "The AI service is currently overloaded. Please try again in a few moments.",
        results: [],
      });
    }

    res.status(500).json({
      error: "Failed to search experts. Please try again later.",
      results: [],
    });
  }
});

// New endpoint to search for experts on the platform (from database)
router.get("/search/experts/platform", async (req, res) => {
  try {
    const {
      researchArea = "",
      diseaseOfInterest = "",
      location,
      userId,
      conditions,
      keywords,
      userLocation,
    } = req.query;

    // Build query to find researchers
    const query = { role: "researcher" };

    // Find all researcher profiles
    const profiles = await Profile.find({ role: "researcher" })
      .populate("userId", "username email medicalInterests")
      .lean();

    // Filter and map to expert format
    let experts = profiles
      .filter((p) => p.userId && p.researcher)
      .map((profile) => {
        const user = profile.userId;
        const researcher = profile.researcher || {};
        const locationObj = researcher.location || {};

        // Build location string: City, State/Province, Country
        const locationParts = [
          locationObj.city,
          locationObj.state,
          locationObj.country,
        ].filter(Boolean);
        const locationStr =
          locationParts.length > 0 ? locationParts.join(", ") : null;

        return {
          _id: user._id || user.id,
          id: user._id || user.id,
          name: user.username || "Unknown Researcher",
          email: user.email,
          orcid: researcher.orcid || null,
          orcidUrl: researcher.orcid
            ? `https://orcid.org/${researcher.orcid}`
            : null,
          biography: researcher.bio || null,
          location: locationStr,
          affiliation: researcher.institutionAffiliation || null,
          currentPosition: researcher.institutionAffiliation || null,
          researchInterests:
            researcher.interests || researcher.specialties || [],
          specialties: researcher.specialties || [],
          education: researcher.education
            ? researcher.education
                .map(
                  (edu) =>
                    `${edu.degree || ""} ${edu.field || ""} ${
                      edu.institution || ""
                    } ${edu.year || ""}`,
                )
                .filter(Boolean)
                .join(", ")
            : null,
          available: researcher.available || false,
          isVerified: researcher.isVerified || false,
          // Store raw location for filtering
          _locationObj: locationObj,
          // Store raw data for matching
          _medicalInterests: user.medicalInterests || [],
          _specialties: researcher.specialties || [],
          _interests: researcher.interests || [],
        };
      });

    // Apply search filters (if search terms provided)
    // If no search terms, return all experts (browsing mode)
    if (researchArea || diseaseOfInterest) {
      const searchTerms = [researchArea, diseaseOfInterest]
        .filter(Boolean)
        .map((term) => term.toLowerCase());

      if (searchTerms.length > 0) {
        experts = experts.filter((expert) => {
          const searchableText = [
            expert.name,
            expert.biography,
            expert.affiliation,
            expert.location,
            ...(expert.researchInterests || []),
            ...(expert.specialties || []),
            ...(expert._medicalInterests || []),
            ...(expert._specialties || []),
            ...(expert._interests || []),
          ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

          return searchTerms.some((term) => searchableText.includes(term));
        });
      }
    }

    // Filter by location if provided (supports City, State/Province, Country)
    // Match if any part of the search location appears in expert's location
    if (location) {
      const searchParts = location
        .split(",")
        .map((p) => p.trim().toLowerCase())
        .filter(Boolean);
      experts = experts.filter((expert) => {
        if (!expert.location) return false;
        const expertLocLower = expert.location.toLowerCase();
        // Must match all specified parts (e.g. "Toronto, Ontario, Canada" matches expert with all three)
        return searchParts.every((part) => expertLocLower.includes(part));
      });
    }

    // Build user profile for matching
    let userProfile = null;
    if (userId) {
      const profile = await Profile.findOne({ userId }).lean();
      if (profile) {
        userProfile = profile;
      }
    } else if (conditions || keywords || userLocation) {
      const locationObj = userLocation
        ? typeof userLocation === "string"
          ? JSON.parse(userLocation)
          : userLocation
        : null;
      userProfile = {
        patient: {
          conditions: conditions
            ? Array.isArray(conditions)
              ? conditions
              : [conditions]
            : [],
          keywords: keywords
            ? Array.isArray(keywords)
              ? keywords
              : [keywords]
            : [],
          location: locationObj,
        },
      };
    }

    // Add research area and disease interest to user profile for enhanced matching
    if (researchArea || diseaseOfInterest) {
      if (!userProfile) {
        userProfile = { patient: {} };
      }
      if (!userProfile.patient) {
        userProfile.patient = {};
      }

      if (researchArea) {
        if (!userProfile.patient.keywords) {
          userProfile.patient.keywords = [];
        }
        if (!userProfile.patient.keywords.includes(researchArea)) {
          userProfile.patient.keywords.push(researchArea);
        }
      }

      if (diseaseOfInterest && diseaseOfInterest !== researchArea) {
        if (!userProfile.patient.conditions) {
          userProfile.patient.conditions = [];
        }
        if (!userProfile.patient.conditions.includes(diseaseOfInterest)) {
          userProfile.patient.conditions.push(diseaseOfInterest);
        }
      }

      userProfile.hasResearchArea = !!researchArea;
      userProfile.hasDiseaseInterest = !!diseaseOfInterest;
      userProfile.researchArea = researchArea;
      userProfile.diseaseInterest = diseaseOfInterest;
    }

    // Calculate match percentages if user profile is available
    const resultsWithMatch = userProfile
      ? experts.map((expert) => {
          const match = calculateExpertMatch(expert, userProfile);
          return {
            ...expert,
            matchPercentage: match.matchPercentage,
            matchExplanation: match.matchExplanation,
          };
        })
      : experts;

    // Sort by match percentage (descending), then by name
    const sortedResults = resultsWithMatch.sort((a, b) => {
      const aMatch = a.matchPercentage ?? -1;
      const bMatch = b.matchPercentage ?? -1;
      if (bMatch !== aMatch) {
        return bMatch - aMatch;
      }
      return (a.name || "").localeCompare(b.name || "");
    });

    res.json({
      results: sortedResults,
    });
  } catch (error) {
    console.error("Error searching platform experts:", error);
    res.status(500).json({
      error: "Failed to search platform experts. Please try again later.",
      results: [],
    });
  }
});

// New pipeline: verified experts (Gemini candidate names -> OpenAlex + Semantic Scholar verification -> metric scoring)
router.get("/search/experts/v2", async (req, res) => {
  try {
    // Check search limit for anonymous users (browser-based deviceId)
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      if (!limitCheck.canSearch) {
        return res.status(429).json({
          error:
            limitCheck.message ||
            "You've used all your free searches! Sign in to continue searching.",
          remaining: 0,
          results: [],
          showSignUpPrompt: limitCheck.showSignUpPrompt,
        });
      }
    }

    const { q = "", location, limit = "10" } = req.query;
    const parsedLimit = Math.max(5, Math.min(10, parseInt(limit, 10) || 10));

    const results = await searchVerifiedExpertsV2({
      q,
      location,
      limit: parsedLimit,
    });

    // Increment search count for anonymous users after successful search
    if (!req.user) {
      await incrementSearchCount(req);
    }

    // Get remaining searches for anonymous users
    let remaining = null;
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      remaining = limitCheck.remaining;
    }

    return res.json({
      results,
      ...(remaining !== null && { remaining }),
    });
  } catch (error) {
    console.error("Error searching experts (v2):", error);
    return res.status(500).json({
      error: "Failed to search verified experts. Please try again later.",
      results: [],
    });
  }
});

// Deterministic expert discovery pipeline (API-first, Gemini only for constraints/summaries)
// Flow: Gemini (constraints only) -> OpenAlex works -> Extract authors -> Semantic Scholar verification -> Ranking -> Gemini (summaries)
router.get("/search/experts/deterministic", async (req, res) => {
  try {
    // Check search limit for anonymous users (browser-based deviceId)
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      if (!limitCheck.canSearch) {
        return res.status(429).json({
          error:
            limitCheck.message ||
            "You've used all your free searches! Sign in to continue searching.",
          remaining: 0,
          results: [],
          showSignUpPrompt: limitCheck.showSignUpPrompt,
        });
      }
    }

    const { q = "", location, page = "1", pageSize = "5" } = req.query;

    if (!q || !q.trim()) {
      return res.json({
        results: [],
        totalFound: 0,
        page: 1,
        pageSize: 5,
        hasMore: false,
        message: "Query is required",
      });
    }

    const parsedPage = Math.max(1, parseInt(page, 10) || 1);
    const parsedPageSize = Math.max(
      1,
      Math.min(10, parseInt(pageSize, 10) || 5),
    );

    console.log(
      `🔍 Deterministic expert search: topic="${q}", location="${
        location || "global"
      }", page=${parsedPage}, pageSize=${parsedPageSize}`,
    );

    // Execute deterministic expert discovery (with pagination)
    const { experts, totalFound, hasMore } = await findDeterministicExperts(
      q.trim(),
      location || null,
      parsedPage,
      parsedPageSize,
    );

    // Format for API response
    const formattedExperts = formatExpertsForResponse(experts);

    // Increment search count for anonymous users only on page 1 (first search)
    if (!req.user && parsedPage === 1) {
      await incrementSearchCount(req);
    }

    // Get remaining searches for anonymous users
    let remaining = null;
    if (!req.user) {
      const limitCheck = await checkSearchLimit(req);
      remaining = limitCheck.remaining;
    }

    return res.json({
      results: formattedExperts,
      totalFound,
      page: parsedPage,
      pageSize: parsedPageSize,
      hasMore,
      method: "deterministic",
      ...(remaining !== null && { remaining }),
    });
  } catch (error) {
    console.error("Error in deterministic expert search:", error);
    return res.status(500).json({
      error:
        "Failed to search experts using deterministic method. Please try again later.",
      results: [],
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// New endpoint to fetch publications for a specific researcher
router.get("/search/expert/publications", async (req, res) => {
  try {
    const { author = "" } = req.query;

    if (!author || !author.trim()) {
      return res.json({ publications: [] });
    }

    const allPublications = await searchGoogleScholarPublications({
      author: author.trim(),
      num: 10,
    });

    // Filter out publications without abstracts
    const publications = (allPublications || []).filter(
      (pub) => pub.abstract && pub.abstract.trim().length > 0,
    );

    res.json({ publications });
  } catch (error) {
    console.error("Error fetching publications:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch publications", publications: [] });
  }
});

// New endpoint to get comprehensive expert profile
router.get("/expert/profile", async (req, res) => {
  try {
    const { name, affiliation, location, orcid, biography, researchInterests } =
      req.query;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Expert name is required" });
    }

    // Build expert data object from query params
    let parsedResearchInterests = null;
    if (researchInterests) {
      try {
        parsedResearchInterests = JSON.parse(researchInterests);
        // Ensure it's an array
        if (!Array.isArray(parsedResearchInterests)) {
          parsedResearchInterests = [parsedResearchInterests];
        }
      } catch (e) {
        // If parsing fails, treat as a single string
        parsedResearchInterests = [researchInterests];
      }
    }

    const expertData = {
      name: name.trim(),
      affiliation: affiliation || null,
      location: location || null,
      orcid: orcid || null,
      biography: biography || null,
      researchInterests: parsedResearchInterests,
    };

    const profile = await getExpertProfile(expertData);

    res.json({ profile });
  } catch (error) {
    console.error("Error fetching expert profile:", error);
    res
      .status(500)
      .json({ error: "Failed to fetch expert profile", profile: null });
  }
});

// Endpoint to get remaining searches for anonymous users
// Optimized with lean() query and early returns
router.get("/search/remaining", async (req, res) => {
  try {
    // Authenticated users have unlimited searches - return immediately
    if (req.user) {
      return res.json({ remaining: null, unlimited: true });
    }

    // Check remaining searches for anonymous users (browser-based deviceId)
    try {
      const limitCheck = await checkSearchLimit(req);
      return res.json({ remaining: limitCheck.remaining, unlimited: false });
    } catch (dbError) {
      console.error("Database error getting remaining searches:", dbError);
      // Fallback to max searches on error
      return res.json({ remaining: MAX_FREE_SEARCHES, unlimited: false });
    }
  } catch (error) {
    console.error("Error getting remaining searches:", error);
    // Return default instead of error to prevent UI issues
    return res.json({ remaining: MAX_FREE_SEARCHES, unlimited: false });
  }
});

// ============================================
// DEBUG ENDPOINT
// ============================================
// Debug endpoint to check search limit status (browser-based deviceId)
// Usage: GET /api/search/debug
router.get("/search/debug", async (req, res) => {
  try {
    const debug = await getSearchLimitDebug(req);
    res.json(debug);
  } catch (error) {
    console.error("Error getting search limit debug:", error);
    res.status(500).json({ error: "Failed to get debug info" });
  }
});

// Endpoint to fetch detailed trial information by NCT ID
router.get("/search/trial/:nctId", async (req, res) => {
  try {
    const { nctId } = req.params;

    if (!nctId || !nctId.trim()) {
      return res.status(400).json({ error: "NCT ID is required" });
    }

    // Clean up NCT ID (remove whitespace, ensure uppercase)
    const cleanNctId = nctId.trim().toUpperCase();

    // Fetch detailed trial information
    const trial = await fetchTrialById(cleanNctId);

    if (!trial) {
      return res.status(404).json({
        error: `Trial with ID ${cleanNctId} not found`,
        trial: null,
      });
    }

    res.json({ trial });
  } catch (error) {
    console.error("Error fetching trial details:", error);
    res.status(500).json({
      error: "Failed to fetch trial details",
      trial: null,
    });
  }
});

// Endpoint to fetch simplified trial details by NCT ID
router.get("/search/trial/:nctId/simplified", async (req, res) => {
  try {
    const { nctId } = req.params;

    if (!nctId || !nctId.trim()) {
      return res.status(400).json({ error: "NCT ID is required" });
    }

    // Clean up NCT ID (remove whitespace, ensure uppercase)
    const cleanNctId = nctId.trim().toUpperCase();

    // Fetch detailed trial information
    const trial = await fetchTrialById(cleanNctId);

    if (!trial) {
      return res.status(404).json({
        error: `Trial with ID ${cleanNctId} not found`,
        trial: null,
      });
    }

    // Simplify trial details using AI
    const simplifiedResult = await simplifyTrialDetails(trial);

    // Handle case where simplifyTrialDetails returns null (shouldn't happen, but safety check)
    if (!simplifiedResult) {
      return res.json({
        trial: trial,
        simplified: false,
      });
    }

    res.json({
      trial: simplifiedResult.trial,
      simplified: simplifiedResult.simplified,
    });
  } catch (error) {
    console.error("Error fetching simplified trial details:", error);
    res.status(500).json({
      error: "Failed to fetch simplified trial details",
      trial: null,
    });
  }
});

// Endpoint to fetch detailed publication information by PMID
router.get("/search/publication/:pmid", async (req, res) => {
  try {
    const { pmid } = req.params;

    if (!pmid || !pmid.trim()) {
      return res.status(400).json({ error: "PMID is required" });
    }

    // Clean up PMID (remove whitespace)
    const cleanPmid = pmid.trim();

    // Fetch detailed publication information
    const publication = await fetchPublicationById(cleanPmid);

    if (!publication) {
      return res.status(404).json({
        error: `Publication with ID ${cleanPmid} not found`,
        publication: null,
      });
    }

    res.json({ publication });
  } catch (error) {
    console.error("Error fetching publication details:", error);
    res.status(500).json({
      error: "Failed to fetch publication details",
      publication: null,
    });
  }
});

// Endpoint to fetch simplified publication details by PMID
router.get("/search/publication/:pmid/simplified", async (req, res) => {
  try {
    const { pmid } = req.params;

    if (!pmid || !pmid.trim()) {
      return res.status(400).json({ error: "PMID is required" });
    }

    // Clean up PMID (remove whitespace)
    const cleanPmid = pmid.trim();

    // Fetch detailed publication information
    const publication = await fetchPublicationById(cleanPmid);

    if (!publication) {
      return res.status(404).json({
        error: `Publication with ID ${cleanPmid} not found`,
        publication: null,
      });
    }

    // Simplify publication details using AI
    const simplifiedResult = await simplifyPublicationDetails(publication);

    res.json({
      publication: simplifiedResult.publication,
      simplified: simplifiedResult.simplified,
    });
  } catch (error) {
    console.error("Error fetching simplified publication details:", error);
    res.status(500).json({
      error: "Failed to fetch simplified publication details",
      publication: null,
    });
  }
});

// Helper function to normalize and calculate name similarity
function calculateNameSimilarity(searchName, authorName) {
  // Normalize: lowercase and remove accents
  const normalize = (str) =>
    str
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const searchNorm = normalize(searchName);
  const authorNorm = normalize(authorName);

  // Split into tokens
  const searchTokens = searchNorm.split(" ").filter((t) => t.length > 1);
  const authorTokens = authorNorm.split(" ").filter((t) => t.length > 1);

  if (searchTokens.length === 0 || authorTokens.length === 0) {
    return 0;
  }

  // Check for exact match
  if (searchNorm === authorNorm) {
    return 1.0;
  }

  // Check if author name contains all search tokens
  let matchedTokens = 0;
  for (const searchToken of searchTokens) {
    for (const authorToken of authorTokens) {
      // Check if tokens match (start with or exact match)
      if (
        authorToken === searchToken ||
        authorToken.startsWith(searchToken) ||
        searchToken.startsWith(authorToken)
      ) {
        matchedTokens++;
        break;
      }
    }
  }

  // Calculate similarity score
  const similarity = matchedTokens / searchTokens.length;
  return similarity;
}

// Search for experts by name using OpenAlex and Semantic Scholar
// GET /api/search/experts/by-name?name=John+Smith
router.get("/search/experts/by-name", async (req, res) => {
  try {
    const { name } = req.query;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name parameter is required" });
    }

    const searchName = name.trim();
    const results = [];
    const seenOrcids = new Set();
    const seenNames = new Set();

    // 1. Search OpenAlex
    try {
      const openAlexUrl = `https://api.openalex.org/authors?search=${encodeURIComponent(
        searchName,
      )}&per_page=20`;

      const openAlexResponse = await fetch(openAlexUrl, {
        headers: {
          "User-Agent": "CuraLink/1.0 (mailto:support@curalink.com)",
        },
      });

      if (openAlexResponse.ok) {
        const openAlexData = await openAlexResponse.json();

        for (const author of openAlexData.results || []) {
          const orcid = author.orcid ? author.orcid.split("/").pop() : null;
          const authorName = author.display_name || "";

          if (!authorName) continue;

          // Calculate name similarity
          const similarity = calculateNameSimilarity(searchName, authorName);

          // Only include results with reasonable name match (at least 50% of search tokens match)
          if (similarity < 0.5) continue;

          // Deduplicate by ORCID or name
          const key = orcid || authorName.toLowerCase();
          if (seenOrcids.has(key) || seenNames.has(authorName.toLowerCase()))
            continue;

          if (orcid) seenOrcids.add(orcid);
          seenNames.add(authorName.toLowerCase());

          const institution =
            author.last_known_institution?.display_name || null;
          const citationCount = author.cited_by_count || 0;
          const hIndex = author.summary_stats?.h_index || 0;
          const topics = (author.topics || [])
            .slice(0, 5)
            .map((t) => t.display_name)
            .filter(Boolean);

          results.push({
            id: author.id,
            name: authorName,
            orcid,
            institution,
            citationCount,
            hIndex,
            topics,
            source: "OpenAlex",
            worksCount: author.works_count || 0,
            similarity, // Include similarity for sorting
          });
        }
      }
    } catch (err) {
      console.error("OpenAlex search error:", err);
    }

    // 2. Search Semantic Scholar (fallback/verification)
    try {
      const semanticScholarUrl = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(
        searchName,
      )}&limit=20&fields=authorId,name,affiliations,citationCount,hIndex,paperCount,externalIds`;

      const semanticResponse = await fetch(semanticScholarUrl);

      if (semanticResponse.ok) {
        const semanticData = await semanticResponse.json();

        for (const author of semanticData.data || []) {
          const orcid = author.externalIds?.ORCID || null;
          const authorName = author.name || "";

          if (!authorName) continue;

          // Calculate name similarity
          const similarity = calculateNameSimilarity(searchName, authorName);

          // Only include results with reasonable name match (at least 50% of search tokens match)
          if (similarity < 0.5) continue;

          const key = orcid || authorName.toLowerCase();
          if (seenOrcids.has(key) || seenNames.has(authorName.toLowerCase()))
            continue;

          if (orcid) seenOrcids.add(orcid);
          seenNames.add(authorName.toLowerCase());

          const institution =
            (author.affiliations || []).map((a) => a).join(", ") || null;
          const citationCount = author.citationCount || 0;
          const hIndex = author.hIndex || 0;

          results.push({
            id: author.authorId,
            name: authorName,
            orcid,
            institution,
            citationCount,
            hIndex,
            topics: [],
            source: "Semantic Scholar",
            worksCount: author.paperCount || 0,
            similarity, // Include similarity for sorting
          });
        }
      }
    } catch (err) {
      console.error("Semantic Scholar search error:", err);
    }

    // Sort by name similarity first, then by citation count
    results.sort((a, b) => {
      // Sort by similarity first (higher is better)
      const simDiff = (b.similarity || 0) - (a.similarity || 0);
      if (Math.abs(simDiff) > 0.1) return simDiff;

      // If similarity is close, sort by citation count
      return (b.citationCount || 0) - (a.citationCount || 0);
    });

    // Remove similarity field before returning (internal use only)
    const cleanedResults = results.map(({ similarity, ...rest }) => rest);

    return res.json({
      results: cleanedResults.slice(0, 20),
      totalFound: results.length,
    });
  } catch (error) {
    console.error("Expert name search error:", error);
    return res
      .status(500)
      .json({ error: "Failed to search for expert by name" });
  }
});

// Reset search limits for testing (development only)
// Usage: POST /api/search/reset-for-testing
router.post("/search/reset-for-testing", async (req, res) => {
  // Only allow in development mode
  if (process.env.NODE_ENV === "production") {
    return res
      .status(403)
      .json({ error: "This endpoint is disabled in production" });
  }

  try {
    // Import IPLimit model (deviceId-based tracking)
    const { IPLimit } = await import("../models/IPLimit.js");

    const result = await IPLimit.updateMany(
      {},
      { $set: { searchCount: 0, lastSearchAt: null } },
    );

    res.json({
      success: true,
      message: "Reset all device-based search limits for testing",
      recordsReset: result.modifiedCount,
      note: "This endpoint only works in development mode",
    });
  } catch (error) {
    console.error("Error resetting search limits for testing:", error);
    res.status(500).json({ error: "Failed to reset search limits" });
  }
});

export default router;
