import axios from "axios";
import { extractExpertInfo } from "./summary.service.js";

// --------------------------------------
// 1. SEARCH RESEARCHERS (Crossref → ORCID)
// --------------------------------------
export async function searchResearchers(query) {
  if (!query) return [];

  try {
    const crossrefRes = await axios.get(
      `https://api.crossref.org/works?query.author=${encodeURIComponent(
        query
      )}&rows=20`,
      { timeout: 8000 }
    );

    const items = crossrefRes.data?.message?.items || [];
    if (!items.length) return [];

    // Extract ORCID IDs from Crossref
    const foundOrcids = new Set();

    items.forEach((item) => {
      (item.author || []).forEach((author) => {
        if (author.ORCID) {
          const id = author.ORCID.replace("https://orcid.org/", "");
          foundOrcids.add(id);
        }
      });
    });

    const orcidIds = Array.from(foundOrcids).slice(0, 8); // limit

    if (!orcidIds.length) return [];

    // Fetch ORCID profiles
    const profiles = await Promise.all(
      orcidIds.map(async (id) => fetchFullORCIDProfile(id))
    );

    return profiles.filter(Boolean);
  } catch (err) {
    console.error("Crossref search failed:", err.message);
    return [];
  }
}

// --------------------------------------
// 2. FETCH FULL ORCID PROFILE (Public API)
// --------------------------------------
export async function fetchFullORCIDProfile(orcidId, skipAI = false) {
  try {
    const res = await axios.get(
      `https://pub.orcid.org/v3.0/${orcidId}/record`,
      {
        headers: { Accept: "application/json" },
        timeout: 8000,
      }
    );

    const record = res.data;
    const person = record.person || {};
    const activities =
      record["activities-summary"] || record.activitiesSummary || {};

    // Basic Info
    const given = person?.name?.["given-names"]?.value || "";
    const family = person?.name?.["family-name"]?.value || "";
    const fullName = `${given} ${family}`.trim() || "Unknown Researcher";

    const biography = person?.biography?.content || null;

    // Affiliations
    const employ =
      activities?.employments?.["employment-summary"] ||
      activities?.employments?.employment_summary ||
      [];
    const edu =
      activities?.educations?.["education-summary"] ||
      activities?.educations?.education_summary ||
      [];
    const aff = [...employ, ...edu];

    const affiliation =
      aff[0]?.organization?.name ||
      aff[0]?.["department-name"] ||
      aff[0]?.department_name ||
      "Not Available";

    const currentPosition = employ[0]
      ? `${employ[0]?.["role-title"] || employ[0]?.role_title || ""} at ${
          employ[0]?.organization?.name || ""
        }`.trim()
      : null;

    // Location
    const addr = person?.addresses?.address || [];
    const location =
      addr[0]?.country?.value ||
      aff[0]?.organization?.address?.city ||
      "Unknown";

    // Research Interests
    const interests =
      (person?.keywords?.keyword || [])
        .map((k) => k?.content)
        .filter(Boolean) || [];

    // Emails (public)
    const email = person?.emails?.email?.[0]?.email || null;

    // Fetch Publications
    const publications = await fetchORCIDWorks(orcidId);

    // Extract external links/researcher URLs
    const externalLinks = {};
    externalLinks.orcid = `https://orcid.org/${orcidId}`;

    const researcherUrls =
      person?.["researcher-urls"]?.["researcher-url"] || [];
    researcherUrls.forEach((urlObj) => {
      const urlName = urlObj["url-name"]?.toLowerCase() || "";
      const urlValue = urlObj.url?.value;

      if (!urlValue) return;

      if (
        urlName.includes("google scholar") ||
        urlValue.includes("scholar.google")
      ) {
        externalLinks.googleScholar = urlValue;
      } else if (urlName.includes("pubmed") || urlValue.includes("pubmed")) {
        externalLinks.pubmed = urlValue;
      } else if (
        urlName.includes("researchgate") ||
        urlValue.includes("researchgate")
      ) {
        externalLinks.researchGate = urlValue;
      } else if (
        urlName.includes("institutional") ||
        urlName.includes("university") ||
        urlName.includes("homepage")
      ) {
        externalLinks.institutional = urlValue;
      } else if (urlName.includes("linkedin")) {
        externalLinks.linkedIn = urlValue;
      } else if (urlName.includes("twitter")) {
        externalLinks.twitter = urlValue;
      }
    });

    // Optional AI extraction from biography
    let aiExtract = {
      education: null,
      age: null,
      yearsOfExperience: null,
      specialties: [],
      achievements: null,
    };

    if (biography && !skipAI) {
      try {
        aiExtract = await Promise.race([
          extractExpertInfo(biography, fullName),
          new Promise((res) => setTimeout(() => res(null), 2000)),
        ]);
        aiExtract ??= {
          education: null,
          age: null,
          yearsOfExperience: null,
          specialties: [],
          achievements: null,
        };
      } catch {}
    }

    // Only return meaningful profiles
    if (
      affiliation === "Not Available" &&
      interests.length === 0 &&
      location === "Unknown"
    ) {
      return null;
    }

    return {
      name: fullName,
      orcid: orcidId,
      orcidId,
      orcidUrl: `https://orcid.org/${orcidId}`,
      biography,
      affiliation,
      currentPosition,
      location,
      researchInterests: interests,
      email,
      publications,
      works: publications, // Alias for compatibility
      impactMetrics: {
        totalPublications: publications.length,
        hIndex: 0,
        totalCitations: 0,
        maxCitations: 0,
      },
      externalLinks,
      education: aiExtract?.education || null,
      age: aiExtract?.age || null,
      yearsOfExperience: aiExtract?.yearsOfExperience || null,
      specialties: aiExtract?.specialties || [],
      achievements: aiExtract?.achievements || null,
    };
  } catch (err) {
    console.error(`ORCID fetch failed for ${orcidId}:`, err.message);
    return null;
  }
}

// --------------------------------------
// 3. FETCH ORCID WORKS (Public API)
// --------------------------------------
async function fetchORCIDWorks(orcidId) {
  try {
    const res = await axios.get(`https://pub.orcid.org/v3.0/${orcidId}/works`, {
      headers: { Accept: "application/json" },
      timeout: 6000,
    });

    const groups = res.data.group || [];

    return groups
      .slice(0, 50)
      .map((g) => {
        const w = g["work-summary"]?.[0];
        if (!w) return null;

        const external = w["external-ids"]?.["external-id"] || [];

        const doi =
          external.find((id) => id["external-id-type"] === "doi")?.[
            "external-id-value"
          ] || null;

        const pmid =
          external.find((id) => id["external-id-type"] === "pmid")?.[
            "external-id-value"
          ] || null;

        // Build publication link
        let link = w.url?.value || null;
        if (!link && doi) {
          link = `https://doi.org/${doi}`;
        } else if (!link && pmid) {
          link = `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;
        }

        // Get authors/contributors
        const contributors = w.contributors?.contributor || [];
        const authors = contributors
          .map((contrib) => {
            return (
              contrib["credit-name"]?.value ||
              contrib.contributor?.attributes?.["credit-name"]?.value ||
              null
            );
          })
          .filter(Boolean);

        return {
          title: w.title?.title?.value || "Untitled",
          year: w["publication-date"]?.year?.value || null,
          month: w["publication-date"]?.month?.value || null,
          day: w["publication-date"]?.day?.value || null,
          journal: w["journal-title"]?.value || null,
          journalTitle: w["journal-title"]?.value || null,
          type: w.type || null,
          workType: w.type || null,
          doi,
          pmid,
          link,
          url: link,
          authors,
          orcidWorkId: w["put-code"],
          id: pmid || doi || w["put-code"],
          citations: 0, // ORCID doesn't provide citations
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error("Fetch works error:", err.message);
    return [];
  }
}

// --------------------------------------
// 4. SEARCH ORCID (Fallback - uses ORCID search)
// --------------------------------------
export async function searchORCID({ q = "" } = {}) {
  if (!q) return [];

  try {
    // First try Crossref search (better results)
    const crossrefResults = await searchResearchers(q);
    if (crossrefResults.length > 0) {
      return crossrefResults.map((profile) => ({
        name: profile.name,
        orcid: profile.orcid || profile.orcidId,
        orcidUrl: profile.orcidUrl,
        affiliation: profile.affiliation,
        location: profile.location,
        researchInterests: profile.researchInterests,
        biography: profile.biography,
        email: profile.email,
        phone: null,
        education: profile.education,
        age: profile.age,
        yearsOfExperience: profile.yearsOfExperience,
        specialties: profile.specialties,
        achievements: profile.achievements,
        currentPosition: profile.currentPosition,
        publications: profile.publications,
        impactMetrics: profile.impactMetrics,
        externalLinks: profile.externalLinks,
      }));
    }

    // Fallback to ORCID expanded search
    const searchRes = await axios.get(
      `https://pub.orcid.org/v3.0/expanded-search/?q=${encodeURIComponent(
        q
      )}&rows=10`,
      {
        headers: { Accept: "application/json" },
        timeout: 10000,
      }
    );

    const items = searchRes.data["expanded-result"] || [];
    if (items.length === 0) return [];

    // Fetch profiles
    const profilePromises = items.slice(0, 6).map(async (item) => {
      const orcidId = item["orcid-id"];
      const displayName = item["display-name"] || "Unknown Researcher";
      try {
        const fullProfile = await fetchFullORCIDProfile(orcidId, false);
        if (!fullProfile) return null;

        return {
          name: fullProfile.name || displayName,
          orcid: orcidId,
          orcidUrl: `https://orcid.org/${orcidId}`,
          affiliation: fullProfile.affiliation,
          location: fullProfile.location,
          researchInterests: fullProfile.researchInterests,
          biography: fullProfile.biography,
          email: fullProfile.email,
          phone: null,
          education: fullProfile.education,
          age: fullProfile.age,
          yearsOfExperience: fullProfile.yearsOfExperience,
          specialties: fullProfile.specialties,
          achievements: fullProfile.achievements,
          currentPosition: fullProfile.currentPosition,
          publications: fullProfile.publications,
          impactMetrics: fullProfile.impactMetrics,
          externalLinks: fullProfile.externalLinks,
        };
      } catch (err) {
        console.error(`Error fetching profile ${orcidId}:`, err.message);
        return null;
      }
    });

    const results = await Promise.allSettled(profilePromises);

    return results
      .filter((r) => r.status === "fulfilled" && r.value !== null)
      .map((r) => r.value);
  } catch (err) {
    console.error("ORCID search failed:", err.message);
    return [];
  }
}
