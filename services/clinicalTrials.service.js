import axios from "axios";

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

// Filter trials by eligibility criteria (client-side filtering)
function filterTrialsByEligibility(trials, filters) {
  if (
    !filters ||
    (!filters.eligibilitySex &&
      !filters.eligibilityAgeMin &&
      !filters.eligibilityAgeMax)
  ) {
    return trials;
  }

  return trials.filter((trial) => {
    const eligibility = trial.eligibility || {};

    // Filter by sex/gender
    if (filters.eligibilitySex && filters.eligibilitySex !== "All") {
      const trialGender = (eligibility.gender || "All").toLowerCase();
      const filterGender = filters.eligibilitySex.toLowerCase();
      if (trialGender !== "all" && trialGender !== filterGender) {
        return false;
      }
    }

    // Filter by age
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

    return true;
  });
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
} = {}) {
  // Extract only country from location (if location contains city and country, use only country)
  let countryOnly = null;
  if (location) {
    // If location is an object with country property, use it directly
    if (typeof location === "object" && location.country) {
      countryOnly = location.country;
    }
    // If location is a string, extract country (assume last word/part is country)
    else if (typeof location === "string") {
      const locationParts = location.trim().split(/\s+/);
      // Use the last part as country (e.g., "Toronto Canada" -> "Canada")
      countryOnly = locationParts[locationParts.length - 1];
    }
  }

  // Build cache key including eligibility filters
  const cacheKey = `ct:${q}:${status || ""}:${countryOnly || ""}:${
    phase || ""
  }:${eligibilitySex || ""}:${eligibilityAgeMin || ""}:${
    eligibilityAgeMax || ""
  }`;
  const cached = getCache(cacheKey);
  if (cached) {
    // Apply client-side filtering for eligibility and phase if needed
    let filtered = filterTrialsByEligibility(cached, {
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
    });
    // Filter by phase if specified
    if (phase) {
      filtered = filtered.filter((trial) => {
        const trialPhase = trial.phase || "";
        // Check if trial phase includes the requested phase
        // Phases can be stored as "PHASE1", "PHASE2", "PHASE3", "PHASE4" or combinations like "PHASE1, PHASE2"
        return trialPhase.toUpperCase().includes(phase.toUpperCase());
      });
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

  const params = new URLSearchParams();
  if (q) params.set("query.term", q);
  if (status) params.set("filter.overallStatus", status);
  // Use query.locn for location-based searches (Essie expression syntax)
  // Use only country for location filtering
  if (countryOnly) {
    params.set("query.locn", countryOnly);
  }
  // Request a larger page size from the API (max is typically 1000)
  // We'll paginate on our side after fetching and filtering
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
      const nextUrl = `https://clinicaltrials.gov/api/v2/studies?${nextParams.toString()}`;

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

    // Get all studies (don't limit here, we'll paginate after filtering)
    const items = allStudies.map((s) => {
      const protocolSection = s.protocolSection || {};
      const identificationModule = protocolSection.identificationModule || {};
      const statusModule = protocolSection.statusModule || {};
      const conditionsModule = protocolSection.conditionsModule || {};
      const eligibilityModule = protocolSection.eligibilityModule || {};
      const designModule = protocolSection.designModule || {};
      const descriptionModule = protocolSection.descriptionModule || {};
      const contactsLocationsModule = s.contactsLocationsModule || {};

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

      // Extract contact info
      const contacts =
        contactsLocationsModule.centralContacts?.map((c) => ({
          name: c.name || "",
          email: c.email || "",
          phone: c.phone || "",
        })) || [];

      // Extract design and phase
      const phases = designModule.phases || [];
      const phase = phases.length > 0 ? phases.join(", ") : "N/A";

      const nctId = identificationModule.nctId || s.nctId || "";
      return {
        id: nctId,
        _id: nctId, // Add _id for consistency
        title:
          identificationModule.officialTitle ||
          identificationModule.briefTitle ||
          "Clinical Trial",
        status: statusModule.overallStatus || "Unknown",
        phase,
        conditions,
        location: locations.join("; ") || "Not specified",
        eligibility,
        contacts,
        description:
          descriptionModule.briefSummary ||
          descriptionModule.detailedDescription ||
          "No description available.",
        // Add ClinicalTrials.gov link
        clinicalTrialsGovUrl: nctId
          ? `https://clinicaltrials.gov/study/${nctId}`
          : null,
      };
    });

    setCache(cacheKey, items);

    // Apply eligibility filtering
    let filteredItems = filterTrialsByEligibility(items, {
      eligibilitySex,
      eligibilityAgeMin,
      eligibilityAgeMax,
    });

    // Filter by phase if specified
    if (phase) {
      filteredItems = filteredItems.filter((trial) => {
        const trialPhase = trial.phase || "";
        // Check if trial phase includes the requested phase
        // Phases can be stored as "PHASE1", "PHASE2", "PHASE3", "PHASE4" or combinations like "PHASE1, PHASE2"
        return trialPhase.toUpperCase().includes(phase.toUpperCase());
      });
    }

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
