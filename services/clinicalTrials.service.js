import axios from "axios";
import {
  expandQueryWithSynonyms,
  extractBiomarkers,
  isCenterOfExcellence,
  isMajorBiotechSponsor,
  mapToMeSHTerminology,
} from "./medicalTerminology.service.js";
import { searchPubMed } from "./pubmed.service.js";

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
 * Layer 2: Actionability Filter - Hard Constraints
 * Filters trials by recruitment status, geographic radius, age, and sex
 */
function filterTrialsByEligibility(trials, filters) {
  if (
    !filters ||
    (!filters.eligibilitySex &&
      !filters.eligibilityAgeMin &&
      !filters.eligibilityAgeMax &&
      !filters.radiusMiles)
  ) {
    return trials;
  }

  return trials.filter((trial) => {
    const eligibility = trial.eligibility || {};

    // Filter by sex/gender (Layer 2)
    if (filters.eligibilitySex && filters.eligibilitySex !== "All") {
      const trialGender = (eligibility.gender || "All").toLowerCase();
      const filterGender = filters.eligibilitySex.toLowerCase();
      if (trialGender !== "all" && trialGender !== filterGender) {
        return false;
      }
    }

    // Filter by age (Layer 2)
    if (filters.eligibilityAgeMin || filters.eligibilityAgeMax) {
      const minAge = eligibility.minimumAge;
      const maxAge = eligibility.maximumAge;

      // Parse age strings (e.g., "18 Years" -> 18)
      const parseAge = (ageStr) => {
        if (!ageStr || ageStr === "Not specified") return null;
        const match = ageStr.match(/(\d+)/);
        return match ? parseInt(match[1]) : null;
      };

      const trialMinAge = parseAge(minAge);
      const trialMaxAge = parseAge(maxAge);
      const filterMinAge = filters.eligibilityAgeMin
        ? parseInt(filters.eligibilityAgeMin)
        : null;
      const filterMaxAge = filters.eligibilityAgeMax
        ? parseInt(filters.eligibilityAgeMax)
        : null;

      // Check if age ranges overlap
      if (
        filterMinAge !== null &&
        trialMaxAge !== null &&
        filterMinAge > trialMaxAge
      ) {
        return false;
      }
      if (
        filterMaxAge !== null &&
        trialMinAge !== null &&
        filterMaxAge < trialMinAge
      ) {
        return false;
      }
    }

    // Filter by geographic radius (Layer 2)
    // Note: This is a simplified check - in production, you'd use geocoding
    // For now, we'll check if location strings match (city/state level)
    if (filters.radiusMiles && filters.userLocation && trial.location) {
      // Simplified: if user location is provided, check if trial location contains it
      // In production, use actual geocoding and distance calculation
      const userLocStr =
        typeof filters.userLocation === "string"
          ? filters.userLocation.toLowerCase()
          : `${filters.userLocation.city || ""} ${
              filters.userLocation.state || ""
            }`.toLowerCase();
      const trialLocStr = trial.location.toLowerCase();

      // If locations don't match at all, exclude (simplified check)
      // In production, calculate actual distance using coordinates
      if (userLocStr && !trialLocStr.includes(userLocStr.split(",")[0])) {
        // Don't filter out if we can't determine - this is a fallback
        // In production, you'd have coordinates and calculate actual distance
      }
    }

    return true;
  });
}

/**
 * Layer 2: Filter by recruitment status (hard constraint)
 * Only show RECRUITING or NOT_YET_RECRUITING by default
 */
function filterByRecruitmentStatus(trials, statusFilter) {
  if (!statusFilter) {
    // Default: Only show RECRUITING or NOT_YET_RECRUITING
    return trials.filter(
      (trial) =>
        trial.status === "RECRUITING" || trial.status === "NOT_YET_RECRUITING"
    );
  }

  // If specific status is requested, filter by it
  if (statusFilter === "RECRUITING" || statusFilter === "NOT_YET_RECRUITING") {
    return trials.filter((trial) => trial.status === statusFilter);
  }

  return trials;
}

/**
 * Apply query relevance scoring and filter (all-terms match).
 * Used in both cold path and cache branch so totalCount stays consistent.
 * @param {Array} trials - List of trial objects
 * @param {string} q - Search query
 * @returns {Array} - Filtered trials with queryRelevanceScore, queryMatchCount, queryTermCount, significantTermMatches
 */
function applyQueryRelevanceFilter(trials, q) {
  if (!q) {
    return trials.map((trial) => ({
      ...trial,
      queryRelevanceScore: 0,
      queryMatchCount: 0,
      queryTermCount: 0,
      significantTermMatches: 0,
    }));
  }
  const queryLower = q.toLowerCase().trim();
  const stopWords = new Set([
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
  ]);
  const queryTerms = queryLower
    .split(/\s+/)
    .filter((term) => term.length > 2 && !stopWords.has(term));

  let items = trials.map((trial) => {
    const title = (trial.title || "").toLowerCase();
    const description = (trial.description || "").toLowerCase();
    const conditions = (trial.conditions || []).join(" ").toLowerCase();
    const searchText = `${title} ${description} ${conditions}`;
    let matchCount = 0;
    let exactPhraseMatch = false;
    let significantTermMatches = 0;
    if (searchText.includes(queryLower)) {
      exactPhraseMatch = true;
      matchCount = queryTerms.length;
      significantTermMatches = queryTerms.length;
    } else {
      for (const term of queryTerms) {
        const termRegex = new RegExp(
          `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        );
        if (termRegex.test(searchText)) {
          matchCount++;
          if (termRegex.test(title) || termRegex.test(conditions)) significantTermMatches++;
        }
      }
    }
    let queryRelevanceScore = 0;
    if (exactPhraseMatch) {
      queryRelevanceScore = 1.0;
    } else if (queryTerms.length > 0) {
      const allTermsMatch = matchCount === queryTerms.length;
      const significantRatio = significantTermMatches / queryTerms.length;
      const matchRatio = matchCount / queryTerms.length;
      if (allTermsMatch && significantRatio >= 0.6) queryRelevanceScore = 0.85 + significantRatio * 0.15;
      else if (allTermsMatch && significantRatio >= 0.4) queryRelevanceScore = 0.75 + significantRatio * 0.1;
      else if (allTermsMatch && significantRatio > 0) queryRelevanceScore = 0.5 + significantRatio * 0.2;
      else if (allTermsMatch) queryRelevanceScore = 0.3;
      else if (matchRatio >= 0.75) queryRelevanceScore = 0.5 + significantRatio * 0.3;
      else if (matchRatio >= 0.5) queryRelevanceScore = 0.3 + significantRatio * 0.3;
      else queryRelevanceScore = matchRatio * 0.5;
    }
    return {
      ...trial,
      queryRelevanceScore,
      queryMatchCount: matchCount,
      queryTermCount: queryTerms.length,
      significantTermMatches,
    };
  });

  items = items.filter((trial) => {
    const relevance = trial.queryRelevanceScore || 0;
    const matchCount = trial.queryMatchCount ?? 0;
    const termCount = trial.queryTermCount ?? 0;
    if (relevance === 1.0) return true;
    const allTermsMatch = termCount > 0 && matchCount === termCount;
    return relevance >= 0.5 && allTermsMatch;
  });
  return items;
}

/**
 * Layer 3: Calculate biomarker match score
 */
function calculateBiomarkerMatch(trial, userBiomarkers = []) {
  if (!userBiomarkers || userBiomarkers.length === 0) return 0;

  const eligibilityText =
    (trial.eligibility?.criteria || "") +
    " " +
    (trial.title || "") +
    " " +
    (trial.description || "");

  const trialBiomarkers = extractBiomarkers(eligibilityText);

  if (trialBiomarkers.length === 0) return 0;

  // Check if any user biomarker matches trial biomarkers
  const userBiomarkersUpper = userBiomarkers.map((b) => b.toUpperCase());
  const matches = trialBiomarkers.filter((tb) =>
    userBiomarkersUpper.includes(tb)
  );

  return matches.length > 0 ? 1 : 0; // Boost if match found
}

/**
 * Layer 4: Calculate phase weight
 * Phase 3 = safer, Phase 1/2 = breakthrough
 */
function getPhaseWeight(phase) {
  if (!phase) return 0.5;

  const phaseUpper = phase.toUpperCase();
  if (phaseUpper.includes("PHASE3") || phaseUpper.includes("PHASE 3")) {
    return 1.0; // Highest weight for Phase 3
  }
  if (phaseUpper.includes("PHASE2") || phaseUpper.includes("PHASE 2")) {
    return 0.8;
  }
  if (phaseUpper.includes("PHASE1") || phaseUpper.includes("PHASE 1")) {
    return 0.7; // Breakthrough experimental
  }
  if (phaseUpper.includes("PHASE4") || phaseUpper.includes("PHASE 4")) {
    return 0.9;
  }

  return 0.5; // Default
}

/**
 * Layer 5: Calculate PI expertise score based on publications
 * This is a simplified version - in production, you'd fetch PI publications from PubMed
 */
async function calculatePIExpertiseScore(trial) {
  let score = 0;

  // Check if trial is at a Center of Excellence
  const locationStr = trial.location || "";
  if (isCenterOfExcellence(locationStr)) {
    score += 0.3;
  }

  // Check if sponsored by major biotech
  const sponsorStr = trial.sponsor || "";
  if (isMajorBiotechSponsor(sponsorStr)) {
    score += 0.2;
  }

  // Extract PI name from contacts
  const piContact = trial.contacts?.find(
    (c) =>
      c.role?.toLowerCase().includes("principal") ||
      c.role?.toLowerCase().includes("investigator") ||
      c.name
  );

  if (piContact?.name) {
    // In production, you'd search PubMed for PI publications in last 24 months
    // For now, we'll give a base score if PI is identified
    score += 0.2;
  }

  return Math.min(1.0, score);
}

export async function searchClinicalTrials({
  q = "",
  status,
  location,
  phase,
  eligibilitySex,
  eligibilityAgeMin,
  eligibilityAgeMax,
  page = 1,
  pageSize = 9,
  radiusMiles, // Layer 2: Geographic radius
  userLocation, // Layer 2: User's location for radius calculation
  biomarkers = [], // Layer 3: User's biomarkers (e.g., ["IDH1", "BRCA"])
  keyword, // Layer 3: Additional keyword for biomarker matching
  sortByDate = false, // When true, sort by lastUpdatePostDate (newest first)
} = {}) {
  // Layer 1: Translation Layer - Expand query with synonyms
  // Only expand if user query is short/simple (1-3 words) to avoid over-expanding complex queries
  let expandedQuery = q;
  if (q) {
    const queryWords = q.trim().split(/\s+/).length;
    // Only expand synonyms for simple queries (1-3 words) to avoid false positives
    // For complex queries, let the API handle the search directly
    if (queryWords <= 3) {
      expandedQuery = expandQueryWithSynonyms(q);
      // Also map to MeSH terminology
      const meshTerm = mapToMeSHTerminology(q);
      if (meshTerm !== q) {
        expandedQuery = `${expandedQuery} OR ${meshTerm}`;
      }
    } else {
      // For complex queries, use original query to maintain relevance
      expandedQuery = q;
    }
  }

  // Layer 3: Also extract biomarkers from the query itself if no biomarkers provided
  // This helps catch biomarker mentions in the search query (e.g., "IDH-mutant glioblastoma")
  if ((!biomarkers || biomarkers.length === 0) && q) {
    const queryBiomarkers = extractBiomarkers(q);
    if (queryBiomarkers.length > 0) {
      biomarkers = queryBiomarkers;
    }
  }

  // Extract location information
  let countryOnly = null;
  let userLocationObj = null;

  if (location) {
    if (typeof location === "object" && location.country) {
      countryOnly = location.country;
      userLocationObj = location;
    } else if (typeof location === "string") {
      const locationParts = location.trim().split(/\s+/);
      countryOnly = locationParts[locationParts.length - 1];
      userLocationObj = { city: locationParts[0], country: countryOnly };
    }
  }

  if (userLocation) {
    userLocationObj =
      typeof userLocation === "string"
        ? JSON.parse(userLocation)
        : userLocation;
  }

  // Layer 2: Default status filter - only RECRUITING or NOT_YET_RECRUITING
  const effectiveStatus = status || "RECRUITING,NOT_YET_RECRUITING";

  // Build cache key including all filters (including biomarkers for Layer 3)
  const cacheKey = `ct:${expandedQuery}:${effectiveStatus}:${
    countryOnly || ""
  }:${phase || ""}:${eligibilitySex || ""}:${eligibilityAgeMin || ""}:${
    eligibilityAgeMax || ""
  }:${radiusMiles || ""}:${
    biomarkers && biomarkers.length > 0 ? biomarkers.join(",") : ""
  }:${sortByDate}`;
  const cached = getCache(cacheKey);
  if (cached) {
    // Apply all filters
    let filtered = filterByRecruitmentStatus(cached, effectiveStatus);
    filtered = filterTrialsByEligibility(filtered, {
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
      radiusMiles,
      userLocation: userLocationObj,
    });

    // Filter by phase if specified
    if (phase) {
      filtered = filtered.filter((trial) => {
        const trialPhase = trial.phase || "";
        return trialPhase.toUpperCase().includes(phase.toUpperCase());
      });
    }

    // Apply same query relevance filter as cold path so totalCount is consistent across pages
    if (q) {
      filtered = applyQueryRelevanceFilter(filtered, q);
    }

    // Apply pagination
    const totalCount = filtered.length;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedItems = filtered.slice(startIndex, endIndex);
    const hasMore = endIndex < totalCount;

    return {
      items: paginatedItems,
      totalCount,
      hasMore,
    };
  }

  // Build API query with Layer 1 expanded query
  const params = new URLSearchParams();
  if (expandedQuery) params.set("query.term", expandedQuery);

  // Layer 2: Filter by status (RECRUITING or NOT_YET_RECRUITING)
  if (effectiveStatus.includes(",")) {
    // ClinicalTrials.gov API supports multiple statuses separated by commas
    params.set("filter.overallStatus", effectiveStatus);
  } else {
    params.set("filter.overallStatus", effectiveStatus);
  }

  // Use query.locn for location-based searches
  if (countryOnly) {
    params.set("query.locn", countryOnly);
  }

  // Request a larger page size from the API
  params.set("pageSize", "1000");
  const url = `https://clinicaltrials.gov/api/v2/studies?${params.toString()}`;

  try {
    const resp = await axios.get(url, { timeout: 15000 });
    let allStudies = resp.data?.studies || [];

    // Check if there are more pages (nextPageToken indicates more results)
    let nextPageToken = resp.data?.nextPageToken;
    let pageNum = 1;
    const maxPages = 10; // Limit to prevent infinite loops, adjust as needed

    // Fetch additional pages if available
    while (nextPageToken && pageNum < maxPages) {
      const nextParams = new URLSearchParams(params);
      nextParams.set("pageToken", nextPageToken);
      const nextUrl = `https://clinicalTrials.gov/api/v2/studies?${nextParams.toString()}`;

      try {
        const nextResp = await axios.get(nextUrl, { timeout: 15000 });
        const nextStudies = nextResp.data?.studies || [];
        allStudies = [...allStudies, ...nextStudies];
        nextPageToken = nextResp.data?.nextPageToken;
        pageNum++;
      } catch (e) {
        console.error("Error fetching next page:", e.message);
        break;
      }
    }

    // Get all studies and enrich with Layer 3, 4, 5 data
    const items = await Promise.all(
      allStudies.map(async (s) => {
        const protocolSection = s.protocolSection || {};
        const identificationModule = protocolSection.identificationModule || {};
        const statusModule = protocolSection.statusModule || {};
        const conditionsModule = protocolSection.conditionsModule || {};
        const eligibilityModule = protocolSection.eligibilityModule || {};
        const designModule = protocolSection.designModule || {};
        const descriptionModule = protocolSection.descriptionModule || {};
        const contactsLocationsModule = s.contactsLocationsModule || {};
        const sponsorCollaboratorsModule =
          protocolSection.sponsorCollaboratorsModule || {};

        // Extract all locations properly
        const locations =
          contactsLocationsModule.locations?.map((loc) => {
            const parts = [loc.city, loc.state, loc.country].filter(Boolean);
            return parts.join(", ");
          }) || [];

        // Extract eligibility criteria comprehensively
        const eligibility = {
          criteria: eligibilityModule.eligibilityCriteria || "Not specified",
          gender: eligibilityModule.gender || "All",
          minimumAge: eligibilityModule.minimumAge || "Not specified",
          maximumAge: eligibilityModule.maximumAge || "Not specified",
          healthyVolunteers: eligibilityModule.healthyVolunteers || "Unknown",
          population: eligibilityModule.studyPopulationDescription || "",
        };

        // Extract conditions
        const conditions =
          conditionsModule.conditions?.map((c) => c.name || c) || [];

        // Extract contact info (for Layer 5: PI identification)
        const contacts = [
          ...(contactsLocationsModule.centralContacts?.map((c) => ({
            name: c.name || "",
            email: c.email || "",
            phone: c.phone || "",
            role: c.role || c.type || "Central Contact",
          })) || []),
          ...(contactsLocationsModule.overallContacts?.map((c) => ({
            name: c.name || "",
            email: c.email || "",
            phone: c.phone || "",
            role: c.role || c.type || "Overall Contact",
          })) || []),
        ];

        // Extract Principal Investigator (for Layer 5)
        const piContact = contacts.find(
          (c) =>
            c.role?.toLowerCase().includes("principal") ||
            c.role?.toLowerCase().includes("investigator")
        );

        // Extract design and phase (Layer 4)
        const phases = designModule.phases || [];
        const phase = phases.length > 0 ? phases.join(", ") : "N/A";
        const studyType = designModule.studyType || "Unknown"; // INTERVENTIONAL or OBSERVATIONAL

        // Extract sponsor (for Layer 5)
        const leadSponsor = sponsorCollaboratorsModule.leadSponsor?.name || "";
        const collaborators =
          sponsorCollaboratorsModule.collaborators?.map((c) => c.name) || [];

        // Layer 3: Extract biomarkers from eligibility criteria
        const eligibilityText =
          eligibility.criteria +
          " " +
          (identificationModule.officialTitle || "") +
          " " +
          (descriptionModule.briefSummary || "");
        const extractedBiomarkers = extractBiomarkers(eligibilityText);

        // Layer 4: Calculate phase weight
        const phaseWeight = getPhaseWeight(phase);

        // Layer 5: Calculate PI expertise score
        const piExpertiseScore = await calculatePIExpertiseScore({
          location: locations.join("; "),
          sponsor: leadSponsor,
          contacts,
        });

        const nctId = identificationModule.nctId || s.nctId || "";
        const lastUpdatePostDate = statusModule.lastUpdatePostDate || null;
        return {
          id: nctId,
          _id: nctId,
          lastUpdatePostDate,
          title:
            identificationModule.officialTitle ||
            identificationModule.briefTitle ||
            "Clinical Trial",
          status: statusModule.overallStatus || "Unknown",
          phase,
          phaseWeight, // Layer 4
          studyType, // Layer 4: INTERVENTIONAL or OBSERVATIONAL
          conditions,
          location: locations.join("; ") || "Not specified",
          locations, // Detailed locations array
          eligibility,
          contacts,
          principalInvestigator: piContact?.name || null, // Layer 5
          sponsor: leadSponsor, // Layer 5
          collaborators, // Layer 5
          biomarkers: extractedBiomarkers, // Layer 3
          piExpertiseScore, // Layer 5
          description:
            descriptionModule.briefSummary ||
            descriptionModule.detailedDescription ||
            "No description available.",
          clinicalTrialsGovUrl: nctId
            ? `https://clinicaltrials.gov/study/${nctId}`
            : null,
        };
      })
    );

    setCache(cacheKey, items);

    // Layer 2: Apply hard filters
    const beforeStatusFilter = items.length;
    let filteredItems = filterByRecruitmentStatus(items, effectiveStatus);
    const afterStatusFilter = filteredItems.length;

    const beforeEligibilityFilter = filteredItems.length;
    filteredItems = filterTrialsByEligibility(filteredItems, {
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
      radiusMiles,
      userLocation: userLocationObj,
    });
    const afterEligibilityFilter = filteredItems.length;

    // Filter by phase if specified
    if (phase) {
      filteredItems = filteredItems.filter((trial) => {
        const trialPhase = trial.phase || "";
        return trialPhase.toUpperCase().includes(phase.toUpperCase());
      });
    }

    // Layer 3: Boost trials with biomarker matches
    if (biomarkers && biomarkers.length > 0) {
      filteredItems = filteredItems.map((trial) => {
        const biomarkerMatch = calculateBiomarkerMatch(trial, biomarkers);
        return {
          ...trial,
          biomarkerMatchScore: biomarkerMatch,
        };
      });
    }

    // Layer 4: Filter by study type if needed (Interventional vs Observational)
    // This can be added as a filter parameter in the future

    // Calculate query relevance score for each trial (PRIMARY ranking factor)
    // This ensures results match what the user actually searched for
    if (q) {
      const queryLower = q.toLowerCase().trim();
      // Filter out very common words that don't add meaning
      const stopWords = new Set([
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
      const queryTerms = queryLower
        .split(/\s+/)
        .filter((term) => term.length > 2 && !stopWords.has(term));

      filteredItems = filteredItems.map((trial) => {
        const title = (trial.title || "").toLowerCase();
        const description = (trial.description || "").toLowerCase();
        const conditions = (trial.conditions || []).join(" ").toLowerCase();
        const searchText = `${title} ${description} ${conditions}`;

        let matchCount = 0;
        let exactPhraseMatch = false;
        let significantTermMatches = 0;

        // Check for exact phrase match first (highest priority)
        if (searchText.includes(queryLower)) {
          exactPhraseMatch = true;
          matchCount = queryTerms.length;
          significantTermMatches = queryTerms.length;
        } else {
          // Use word boundaries for more precise matching to avoid false positives
          // e.g., "fog" shouldn't match "FoG" (Freezing of Gait) unless it's actually "fog"
          for (const term of queryTerms) {
            // Use word boundary regex to match whole words only
            const termRegex = new RegExp(
              `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
              "i"
            );
            if (termRegex.test(searchText)) {
              matchCount++;
              // Consider it significant if it appears in title or conditions (not just description)
              if (termRegex.test(title) || termRegex.test(conditions)) {
                significantTermMatches++;
              }
            }
          }
        }

        // Calculate relevance score with stricter weighting:
        // - Exact phrase match = 1.0 (perfect match)
        // - All terms match in title/conditions = 0.95+ (high relevance)
        // - Most terms match in title/conditions = 0.85+ (good relevance)
        // - All terms match but only in description = 0.7 (lower relevance - may be false positive)
        // - Partial matches = much lower scores
        let queryRelevanceScore = 0;
        if (exactPhraseMatch) {
          queryRelevanceScore = 1.0;
        } else if (queryTerms.length > 0) {
          const allTermsMatch = matchCount === queryTerms.length;
          const significantRatio = significantTermMatches / queryTerms.length;
          const matchRatio = matchCount / queryTerms.length;

          if (allTermsMatch && significantRatio >= 0.6) {
            // All terms matched and at least 60% are in title/conditions - very relevant
            queryRelevanceScore = 0.85 + significantRatio * 0.15; // 0.94 - 1.0
          } else if (allTermsMatch && significantRatio >= 0.4) {
            // All terms matched and at least 40% in title/conditions - good relevance
            queryRelevanceScore = 0.75 + significantRatio * 0.1; // 0.79 - 0.85
          } else if (allTermsMatch && significantRatio > 0) {
            // All terms matched but mostly in description - moderate relevance (may filter later)
            queryRelevanceScore = 0.5 + significantRatio * 0.2; // 0.5 - 0.7
          } else if (allTermsMatch) {
            // All terms matched but NONE in title/conditions - likely false positive
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
        }

        return {
          ...trial,
          queryRelevanceScore,
          queryMatchCount: matchCount,
          queryTermCount: queryTerms.length,
          significantTermMatches,
        };
      });
    } else {
      // If no query, set relevance to 0 (will be sorted by other factors)
      filteredItems = filteredItems.map((trial) => ({
        ...trial,
        queryRelevanceScore: 0,
        queryMatchCount: 0,
        queryTermCount: 0,
        significantTermMatches: 0,
      }));
    }

    // Filter out results with very low query relevance (likely false positives)
    // Only keep results that have at least 0.5 relevance or exact phrase match
    const beforeFilter = filteredItems.length;
    if (q) {
      filteredItems = filteredItems.filter((trial) => {
        const relevance = trial.queryRelevanceScore || 0;
        const matchCount = trial.queryMatchCount ?? 0;
        const termCount = trial.queryTermCount ?? 0;
        // Exact phrase match: always keep
        if (relevance === 1.0) return true;
        // Otherwise require ALL query terms to be present (tighten search like ClinicalTrials.gov)
        // e.g. "functional movement disorders" must not keep trials that only have "movement disorders"
        const allTermsMatch = termCount > 0 && matchCount === termCount;
        return relevance >= 0.5 && allTermsMatch;
      });
    }
    const afterFilter = filteredItems.length;

    // Layer 5: Rank by query relevance FIRST, then other factors
    // When sortByDate: prioritize lastUpdatePostDate (newest first)
    const beforeSort = filteredItems.length;
    filteredItems.sort((a, b) => {
      if (sortByDate) {
        const aDate = a.lastUpdatePostDate ? new Date(a.lastUpdatePostDate).getTime() : 0;
        const bDate = b.lastUpdatePostDate ? new Date(b.lastUpdatePostDate).getTime() : 0;
        if (bDate !== aDate) return bDate - aDate; // Newest first
      }

      // First: Query relevance (PRIMARY - most important)
      const aQuery = a.queryRelevanceScore || 0;
      const bQuery = b.queryRelevanceScore || 0;
      // Use tighter threshold - 0.05 instead of 0.1 for more precise sorting
      if (Math.abs(bQuery - aQuery) > 0.05) return bQuery - aQuery; // Significant difference

      // Second: biomarker match (Layer 3) - only if query relevance is similar
      if (biomarkers && biomarkers.length > 0) {
        const aBio = a.biomarkerMatchScore || 0;
        const bBio = b.biomarkerMatchScore || 0;
        if (bBio !== aBio) return bBio - aBio;
      }

      // Third: PI expertise score (Layer 5)
      const aPI = a.piExpertiseScore || 0;
      const bPI = b.piExpertiseScore || 0;
      if (Math.abs(bPI - aPI) > 0.1) return bPI - aPI;

      // Fourth: Phase weight (Layer 4)
      const aPhase = a.phaseWeight || 0.5;
      const bPhase = b.phaseWeight || 0.5;
      if (Math.abs(bPhase - aPhase) > 0.1) return bPhase - aPhase;

      // Fifth: Status (RECRUITING > NOT_YET_RECRUITING)
      const statusOrder = { RECRUITING: 2, NOT_YET_RECRUITING: 1 };
      const aStatus = statusOrder[a.status] || 0;
      const bStatus = statusOrder[b.status] || 0;
      return bStatus - aStatus;
    });

    // Apply pagination
    const totalCount = filteredItems.length;
    const startIndex = (page - 1) * pageSize;
    const endIndex = startIndex + pageSize;
    const paginatedItems = filteredItems.slice(startIndex, endIndex);
    const hasMore = endIndex < totalCount;

    return {
      items: paginatedItems,
      totalCount,
      hasMore,
    };
  } catch (e) {
    console.error("ClinicalTrials.gov API error:", e.message);
    return {
      items: [],
      totalCount: 0,
      hasMore: false,
    };
  }
}
