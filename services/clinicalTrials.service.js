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

export async function searchClinicalTrials({ q = "", status, location } = {}) {
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

  const key = `ct:${q}:${status || ""}:${countryOnly || ""}`;
  const cached = getCache(key);
  if (cached) return cached;

  const params = new URLSearchParams();
  if (q) params.set("query.term", q);
  if (status) params.set("filter.overallStatus", status);
  // Use query.locn for location-based searches (Essie expression syntax)
  // Use only country for location filtering
  if (countryOnly) {
    params.set("query.locn", countryOnly);
  }
  const url = `https://clinicaltrials.gov/api/v2/studies?${params.toString()}`;

  try {
    const resp = await axios.get(url, { timeout: 15000 });
    const items = (resp.data?.studies || []).slice(0, 15).map((s) => {
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

    setCache(key, items);
    return items;
  } catch (e) {
    console.error("ClinicalTrials.gov API error:", e.message);
    return [];
  }
}
