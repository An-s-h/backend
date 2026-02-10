import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import dotenv from "dotenv";
import rateLimiter from "../utils/geminiRateLimiter.js";
import { searchGoogleScholarPublications } from "./googleScholar.service.js";
import { searchClinicalTrials } from "./clinicalTrials.service.js";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

// Cache for expert profiles
const profileCache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour cache

function getCacheKey(expertName) {
  return `expert:profile:${expertName.toLowerCase().trim()}`;
}

function getCache(key) {
  const item = profileCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    profileCache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  profileCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });

  if (profileCache.size > 50) {
    const now = Date.now();
    for (const [k, v] of profileCache.entries()) {
      if (now > v.expires) {
        profileCache.delete(k);
      }
    }
  }
}

/**
 * Generate AI summary for expert bio
 */
async function generateBioSummary(expertData) {
  if (!genAI) return null;

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({ model: modelName });
    const prompt = `Generate a concise 2-3 sentence professional summary for this researcher:
    
Name: ${expertData.name || "Unknown"}
Affiliation: ${expertData.affiliation || "Unknown"}
Research Interests: ${(expertData.researchInterests || []).join(", ")}
Biography: ${expertData.biography || ""}

Create a professional, factual summary highlighting their expertise and impact. Keep it to 2-3 sentences maximum.`;

    const expertDataLength = JSON.stringify(expertData).length;
    const estimatedTokens = 100 + expertDataLength / 4 + 150;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 150,
            temperature: 0.7,
          },
        });
      },
      modelName,
      estimatedTokens
    );

    let summary = result.response.text().trim();
    // Clean up common AI artifacts
    summary = summary
      .replace(/^AI[:\s]*/i, "")
      .replace(/^Summary[:\s]*/i, "")
      .replace(/^Here[^:]*:\s*/i, "")
      .replace(/^This[^:]*:\s*/i, "")
      .trim();
    return summary;
  } catch (error) {
    console.error("Error generating bio summary:", error.message);
    return null;
  }
}

/**
 * Extract research interests from publications
 */
function extractResearchInterests(publications) {
  const interests = new Set();

  publications.forEach((pub) => {
    // Extract keywords from titles and snippets
    const text = `${pub.title || ""} ${pub.snippet || ""}`.toLowerCase();

    // Common research interest keywords
    const keywords = [
      "oncology",
      "cancer",
      "immunotherapy",
      "glioblastoma",
      "tumor",
      "neurosurgery",
      "parkinson",
      "alzheimer",
      "dementia",
      "stroke",
      "cardiology",
      "diabetes",
      "obesity",
      "metabolism",
      "genetics",
      "genomics",
      "proteomics",
      "biomarker",
      "diagnostic",
      "therapeutic",
      "machine learning",
      "artificial intelligence",
      "deep learning",
      "clinical trial",
      "translational",
      "precision medicine",
      "personalized",
    ];

    keywords.forEach((keyword) => {
      if (text.includes(keyword)) {
        interests.add(keyword.charAt(0).toUpperCase() + keyword.slice(1));
      }
    });
  });

  return Array.from(interests).slice(0, 10);
}

/**
 * Calculate impact metrics from publications
 */
function calculateImpactMetrics(publications) {
  const totalPublications = publications.length;
  const citations = publications.map((p) => p.citations || 0);
  const totalCitations = citations.reduce((sum, c) => sum + c, 0);
  const maxCitations = citations.length > 0 ? Math.max(...citations) : 0;

  // Calculate average citations per publication
  const avgCitations =
    totalPublications > 0
      ? Math.round((totalCitations / totalPublications) * 10) / 10 // Round to 1 decimal place
      : 0;

  // Calculate years active (span of publication years)
  const years = publications
    .map((p) => p.year)
    .filter((y) => y && y > 1900 && y <= new Date().getFullYear());
  const yearsActive =
    years.length > 0 ? Math.max(...years) - Math.min(...years) + 1 : 0;

  // Calculate recent publications (last 5 years)
  const currentYear = new Date().getFullYear();
  const recentPublications = publications.filter(
    (p) => p.year && p.year >= currentYear - 5
  ).length;

  return {
    totalPublications,
    totalCitations,
    maxCitations,
    avgCitations,
    yearsActive,
    recentPublications,
  };
}

/**
 * Search for clinical trials associated with expert
 */
async function findAssociatedTrials(expertName, researchInterests) {
  try {
    // Search for trials related to their research interests
    const query = researchInterests.slice(0, 2).join(" ") || expertName;
    const result = await searchClinicalTrials({ q: query, pageSize: 5 });

    // searchClinicalTrials returns { items, totalCount, hasMore }
    // Extract the items array
    const trials = result?.items || [];

    // Filter trials that might be related (simple keyword matching)
    const expertNameLower = expertName.toLowerCase();
    return trials
      .filter((trial) => {
        const title = (trial.title || "").toLowerCase();
        const description = (trial.description || "").toLowerCase();
        return (
          title.includes(expertNameLower) ||
          description.includes(expertNameLower)
        );
      })
      .slice(0, 5);
  } catch (error) {
    console.error("Error finding associated trials:", error.message);
    return [];
  }
}

/**
 * Find related experts based on research interests
 */
async function findRelatedExperts(expertData, currentExpertName) {
  try {
    // This would ideally use the gemini service to find similar experts
    // For now, return empty array - can be enhanced later
    return [];
  } catch (error) {
    console.error("Error finding related experts:", error.message);
    return [];
  }
}

/**
 * Get comprehensive expert profile
 * @param {Object} expertData - Basic expert data (name, affiliation, etc.)
 * @returns {Promise<Object>} Comprehensive expert profile
 */
export async function getExpertProfile(expertData) {
  if (!expertData || !expertData.name) {
    throw new Error("Expert name is required");
  }
  const cacheKey = getCacheKey(expertData.name);
  const cached = getCache(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    // Fetch publications (Google Scholar) with timeout and reduced count to improve latency
    let publications = [];
    const PUBLICATIONS_TIMEOUT_MS = 4000;
    try {
      publications = await Promise.race([
        searchGoogleScholarPublications({
          author: expertData.name,
          num: 10,
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("searchGoogleScholarPublications timeout")),
            PUBLICATIONS_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (error) {
      console.error("Error searching Google Scholar:", error.message);
      publications = [];
    }

    // Extract additional data
    const researchInterests = extractResearchInterests(publications);
    const impactMetrics = calculateImpactMetrics(publications);
    const topPublications = publications
      .sort((a, b) => (b.citations || 0) - (a.citations || 0))
      .slice(0, 10);

    // Generate AI bio summary
    const bioSummary = await generateBioSummary({
      ...expertData,
      publications: topPublications,
    }).catch(() => null); // Fallback if AI generation fails

    // Find associated clinical trials (with timeout to avoid blocking profile load too long)
    let associatedTrials = [];
    const TRIALS_TIMEOUT_MS = 3000;
    try {
      associatedTrials = await Promise.race([
        findAssociatedTrials(expertData.name, researchInterests),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("findAssociatedTrials timeout")),
            TRIALS_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch (error) {
      console.error("Error finding associated trials:", error.message);
      associatedTrials = [];
    }

    // Build comprehensive profile
    const profile = {
      // Basic Info
      name: expertData.name,
      degrees: expertData.degrees || null,
      specialty: expertData.specialty || researchInterests[0] || "Research",
      affiliation: expertData.affiliation || expertData.university || "Unknown",
      location: expertData.location || "",
      orcid: expertData.orcid || null,
      email: expertData.email || null,

      // Profile Image (will be auto-generated on frontend)
      profileImage: null,

      // Status
      onCuraLink: false,
      contactable: false,

      // Summary
      bioSummary: bioSummary || expertData.biography || "",
      biography: expertData.biography || "",

      // Publications
      publications: topPublications,
      totalPublications: impactMetrics.totalPublications,

      // Research Interests
      researchInterests:
        researchInterests.length > 0
          ? researchInterests
          : Array.isArray(expertData.researchInterests)
          ? expertData.researchInterests
          : typeof expertData.researchInterests === "string"
          ? JSON.parse(expertData.researchInterests || "[]")
          : [],

      // Areas of Expertise (derived from research interests, or use original if available)
      areasOfExpertise:
        researchInterests.length > 0
          ? researchInterests.slice(0, 5)
          : Array.isArray(expertData.researchInterests)
          ? expertData.researchInterests.slice(0, 5)
          : [],

      // Clinical Trials
      associatedTrials: associatedTrials,

      // Impact Metrics
      impactMetrics: {
        totalPublications: impactMetrics.totalPublications,
        totalCitations: impactMetrics.totalCitations,
        maxCitations: impactMetrics.maxCitations,
        hIndex: impactMetrics.hIndex,
      },

      // External Links (construct search URLs)
      externalLinks: {
        googleScholar: expertData.name
          ? `https://scholar.google.com/scholar?q=author:"${encodeURIComponent(
              expertData.name
            )}"`
          : null,
        pubmed: expertData.name
          ? `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(
              expertData.name
            )}[Author]`
          : null,
        researchGate: expertData.name
          ? `https://www.researchgate.net/search?q=${encodeURIComponent(
              expertData.name
            )}`
          : null,
        orcid: expertData.orcid
          ? `https://orcid.org/${expertData.orcid}`
          : null,
        institutional:
          expertData.affiliation && expertData.name
            ? `https://www.google.com/search?q=${encodeURIComponent(
                `${expertData.name} ${expertData.affiliation}`
              )}`
            : null,
      },

      // Related Experts (can be populated later)
      relatedExperts: [],

      // Activity Timeline (recent publications)
      activityTimeline: topPublications.slice(0, 5).map((pub) => ({
        type: "publication",
        title: pub.title,
        year: pub.year,
        description: pub.snippet?.substring(0, 100) || "",
      })),
    };

    // Cache the profile
    setCache(cacheKey, profile);

    return profile;
  } catch (error) {
    console.error("Error getting expert profile:", error.message);
    throw error;
  }
}
