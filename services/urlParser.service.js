import axios from "axios";
import { DOMParser } from "xmldom";
import { searchClinicalTrials } from "./clinicalTrials.service.js";

/**
 * Parse a URL and determine if it's a ClinicalTrials.gov or PubMed URL
 * Returns { type: 'trial' | 'publication', id: string } or null
 */
export function parseUrl(url) {
  if (!url || typeof url !== "string") return null;

  try {
    const trimmedUrl = url.trim();
    
    // Basic validation: URL should start with http:// or https://
    if (!trimmedUrl.startsWith("http://") && !trimmedUrl.startsWith("https://")) {
      return null;
    }
    
    const urlObj = new URL(trimmedUrl);

    // Check for ClinicalTrials.gov URLs
    // Examples:
    // - https://clinicaltrials.gov/study/NCT12345678
    // - https://clinicaltrials.gov/ct2/show/NCT12345678
    // - https://www.clinicaltrials.gov/study/NCT12345678
    if (
      urlObj.hostname.includes("clinicaltrials.gov") ||
      urlObj.hostname.includes("clinicaltrials.gov")
    ) {
      // Extract NCT ID from path
      const pathMatch = urlObj.pathname.match(/NCT\d+/i);
      if (pathMatch) {
        return {
          type: "trial",
          id: pathMatch[0].toUpperCase(),
        };
      }
      // Also check query params
      const nctParam = urlObj.searchParams.get("term") || urlObj.searchParams.get("id");
      if (nctParam && /NCT\d+/i.test(nctParam)) {
        return {
          type: "trial",
          id: nctParam.match(/NCT\d+/i)[0].toUpperCase(),
        };
      }
    }

    // Check for PubMed URLs
    // Examples:
    // - https://pubmed.ncbi.nlm.nih.gov/12345678/
    // - https://www.ncbi.nlm.nih.gov/pubmed/12345678
    // - https://www.ncbi.nlm.nih.gov/pubmed/?term=12345678
    if (
      urlObj.hostname.includes("pubmed.ncbi.nlm.nih.gov") ||
      urlObj.hostname.includes("ncbi.nlm.nih.gov")
    ) {
      // Extract PMID from path
      const pathMatch = urlObj.pathname.match(/\/(\d+)\/?$/);
      if (pathMatch) {
        return {
          type: "publication",
          id: pathMatch[1],
        };
      }
      // Check query params
      const termParam = urlObj.searchParams.get("term");
      if (termParam && /^\d+$/.test(termParam)) {
        return {
          type: "publication",
          id: termParam,
        };
      }
    }

    return null;
  } catch (error) {
    // Silently handle invalid URL errors - this is expected for invalid input
    // Only log if it's an unexpected error type
    if (error.code !== "ERR_INVALID_URL") {
      console.error("Unexpected error parsing URL:", error);
    }
    return null;
  }
}

/**
 * Fetch trial data by NCT ID from ClinicalTrials.gov API
 */
export async function fetchTrialById(nctId) {
  try {
    // Use the search API with the specific NCT ID as the search term
    const url = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(nctId)}`;
    const resp = await axios.get(url, { timeout: 15000 });

    // The API returns studies array, find the one matching our NCT ID exactly
    const studies = resp.data?.studies || [];
    const study = studies.find((s) => {
      const nctIdFromStudy = s.protocolSection?.identificationModule?.nctId || s.nctId;
      return nctIdFromStudy && (nctIdFromStudy.toUpperCase() === nctId.toUpperCase());
    });

    if (!study) {
      // If not found in search results, try a more specific search
      // Sometimes we need to search with the full NCT format
      const altUrl = `https://clinicaltrials.gov/api/v2/studies?query.term=${encodeURIComponent(nctId.toUpperCase())}`;
      const altResp = await axios.get(altUrl, { timeout: 15000 });
      const altStudies = altResp.data?.studies || [];
      const altStudy = altStudies.find((s) => {
        const nctIdFromStudy = s.protocolSection?.identificationModule?.nctId || s.nctId;
        return nctIdFromStudy && (nctIdFromStudy.toUpperCase() === nctId.toUpperCase());
      });
      if (!altStudy) return null;
      const s = altStudy;
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

      const nctIdFinal = identificationModule.nctId || nctId.toUpperCase();
      return {
        id: nctIdFinal,
        _id: nctIdFinal,
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
        clinicalTrialsGovUrl: `https://clinicaltrials.gov/study/${nctIdFinal}`,
      };
    }

    const s = study;
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

    const nctIdFinal = identificationModule.nctId || nctId;
    return {
      id: nctIdFinal,
      _id: nctIdFinal,
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
      clinicalTrialsGovUrl: `https://clinicaltrials.gov/study/${nctIdFinal}`,
    };
  } catch (error) {
    console.error("Error fetching trial by ID:", error);
    return null;
  }
}

/**
 * Fetch publication data by PMID from PubMed API
 */
export async function fetchPublicationById(pmid) {
  try {
    // Use EFetch to get detailed metadata
    const efetchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi`;
    const efetchParams = new URLSearchParams({
      db: "pubmed",
      id: pmid,
      retmode: "xml",
    });
    const xmlResp = await axios.get(`${efetchUrl}?${efetchParams}`, {
      timeout: 15000,
    });

    // Parse XML
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(xmlResp.data, "text/xml");
    const article = xmlDoc.getElementsByTagName("PubmedArticle")[0];
    if (!article) return null;

    const getText = (tag) =>
      article.getElementsByTagName(tag)[0]?.textContent || "";
    const getAllText = (tag) =>
      Array.from(article.getElementsByTagName(tag)).map(
        (el) => el.textContent || ""
      );

    const pmidFinal = getText("PMID");
    const title = getText("ArticleTitle");

    // Get full abstract - concatenate all AbstractText elements
    const abstractElements = article.getElementsByTagName("AbstractText");
    let abstract = "";
    if (abstractElements.length > 0) {
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
    const pages = getText("MedlinePgn");

    // Get DOI
    let doi = "";
    const eLocationIds = article.getElementsByTagName("ELocationID");
    for (let i = 0; i < eLocationIds.length; i++) {
      const eidType = eLocationIds[i].getAttribute("EIdType");
      if (eidType === "doi") {
        doi = eLocationIds[i].textContent || "";
        break;
      }
    }

    // Get authors
    const authorList = article.getElementsByTagName("AuthorList")[0];
    const authors = [];
    if (authorList) {
      const authorElements = authorList.getElementsByTagName("Author");
      for (let i = 0; i < authorElements.length; i++) {
        const author = authorElements[i];
        const lastName = author.getElementsByTagName("LastName")[0]?.textContent || "";
        const foreName = author.getElementsByTagName("ForeName")[0]?.textContent || "";
        const initials = author.getElementsByTagName("Initials")[0]?.textContent || "";
        if (lastName) {
          authors.push(
            foreName || initials
              ? `${lastName} ${foreName || initials}`
              : lastName
          );
        }
      }
    }

    // Get affiliations
    const affiliations = getAllText("Affiliation");

    // Get keywords
    const keywordList = article.getElementsByTagName("KeywordList");
    const keywords = [];
    if (keywordList.length > 0) {
      const keywordElements = keywordList[0].getElementsByTagName("Keyword");
      for (let i = 0; i < keywordElements.length; i++) {
        keywords.push(keywordElements[i].textContent || "");
      }
    }

    // Get MeSH terms
    const meshList = article.getElementsByTagName("MeshHeadingList");
    const meshTerms = [];
    if (meshList.length > 0) {
      const meshElements = meshList[0].getElementsByTagName("DescriptorName");
      for (let i = 0; i < meshElements.length; i++) {
        meshTerms.push(meshElements[i].textContent || "");
      }
    }

    // Get publication types
    const pubTypeList = article.getElementsByTagName("PublicationTypeList");
    const publicationTypes = [];
    if (pubTypeList.length > 0) {
      const pubTypeElements = pubTypeList[0].getElementsByTagName("PublicationType");
      for (let i = 0; i < pubTypeElements.length; i++) {
        publicationTypes.push(pubTypeElements[i].textContent || "");
      }
    }

    return {
      id: pmidFinal,
      _id: pmidFinal,
      pmid: pmidFinal,
      title,
      abstract,
      journal,
      year: pubYear,
      month: pubMonth,
      day: pubDay,
      volume,
      issue,
      pages,
      doi,
      authors,
      affiliations,
      keywords,
      meshTerms,
      publicationTypes,
      link: `https://pubmed.ncbi.nlm.nih.gov/${pmidFinal}/`,
      url: `https://pubmed.ncbi.nlm.nih.gov/${pmidFinal}/`,
    };
  } catch (error) {
    console.error("Error fetching publication by ID:", error);
    return null;
  }
}

/**
 * Main function to fetch data from URL
 */
export async function fetchDataFromUrl(url) {
  // Validate input
  if (!url || typeof url !== "string") {
    return {
      success: false,
      error: "Invalid URL. Please provide a valid ClinicalTrials.gov or PubMed URL.",
    };
  }

  try {
    const parsed = parseUrl(url);
    if (!parsed) {
      return {
        success: false,
        error: "Invalid URL. Please provide a ClinicalTrials.gov or PubMed URL.",
      };
    }

    if (parsed.type === "trial") {
      const trial = await fetchTrialById(parsed.id);
      if (!trial) {
        return {
          success: false,
          error: `Trial with ID ${parsed.id} not found.`,
        };
      }
      return {
        success: true,
        type: "trial",
        data: trial,
      };
    } else if (parsed.type === "publication") {
      const publication = await fetchPublicationById(parsed.id);
      if (!publication) {
        return {
          success: false,
          error: `Publication with ID ${parsed.id} not found.`,
        };
      }
      return {
        success: true,
        type: "publication",
        data: publication,
      };
    }

    // Should not reach here, but handle just in case
    return {
      success: false,
      error: "Unsupported URL type.",
    };
  } catch (error) {
    console.error("Error fetching data from URL:", error);
    return {
      success: false,
      error: "Failed to fetch data. Please try again later.",
    };
  }
}

