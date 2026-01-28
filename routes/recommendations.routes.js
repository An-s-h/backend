import { Router } from "express";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { searchClinicalTrials } from "../services/clinicalTrials.service.js";
import { searchPubMed } from "../services/pubmed.service.js";
import { findResearchersWithGemini } from "../services/geminiExperts.service.js";
import {
  calculateTrialMatch,
  calculatePublicationMatch,
  calculateExpertMatch,
} from "../services/matching.service.js";
import {
  extractBiomarkers,
} from "../services/medicalTerminology.service.js";
import {
  batchSimplifyTrialTitles,
} from "../services/trialSimplification.service.js";

const router = Router();

// Cache for recommendations data per user
const recommendationsCache = new Map();
const RECOMMENDATIONS_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache

function getRecommendationsCache(userId) {
  const key = `recommendations:${userId}`;
  const item = recommendationsCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    recommendationsCache.delete(key);
    return null;
  }
  return item.value;
}

function setRecommendationsCache(userId, value) {
  const key = `recommendations:${userId}`;
  recommendationsCache.set(key, {
    value,
    expires: Date.now() + RECOMMENDATIONS_CACHE_TTL_MS,
  });

  // Cleanup old cache entries if cache gets too large (prevent memory leaks)
  if (recommendationsCache.size > 100) {
    const now = Date.now();
    const keysToDelete = [];
    for (const [k, v] of recommendationsCache.entries()) {
      if (now > v.expires) {
        keysToDelete.push(k);
      }
    }
    // Delete expired entries
    keysToDelete.forEach((k) => recommendationsCache.delete(k));
    
    // If still too large, remove oldest entries (FIFO)
    if (recommendationsCache.size > 100) {
      const entries = Array.from(recommendationsCache.entries());
      entries.sort((a, b) => a[1].expires - b[1].expires);
      const toRemove = entries.slice(0, entries.length - 100);
      toRemove.forEach(([k]) => recommendationsCache.delete(k));
    }
  }
}

// Periodic cleanup of expired cache entries (every 10 minutes)
setInterval(() => {
  const now = Date.now();
  const keysToDelete = [];
  for (const [k, v] of recommendationsCache.entries()) {
    if (now > v.expires) {
      keysToDelete.push(k);
    }
  }
  keysToDelete.forEach((k) => recommendationsCache.delete(k));
  if (keysToDelete.length > 0) {
    console.log(`Cleaned up ${keysToDelete.length} expired cache entries`);
  }
}, 1000 * 60 * 10); // Every 10 minutes

// Get all researchers (for dashboards)
router.get("/researchers", async (req, res) => {
  try {
    const { excludeUserId } = req.query;
    const profiles = await Profile.find({ role: "researcher" })
      .populate("userId", "username email")
      .lean();

    const researchers = profiles
      .filter((p) => {
        // Exclude current user if excludeUserId is provided
        if (excludeUserId && p.userId?._id?.toString() === excludeUserId) {
          return false;
        }
        // Only include verified experts
        return p.userId && p.researcher && p.researcher.isVerified === true;
      })
      .map((profile) => {
        const user = profile.userId;
        const researcher = profile.researcher || {};
        return {
          _id: profile.userId._id || profile.userId.id,
          userId: profile.userId._id || profile.userId.id,
          name: user.username || "Unknown Researcher",
          email: user.email,
          orcid: researcher.orcid || null,
          bio: researcher.bio || null,
          location: researcher.location || null,
          specialties: researcher.specialties || [],
          interests: researcher.interests || [],
          available: researcher.available || false,
          isVerified: researcher.isVerified || false,
        };
      });

    res.json({ researchers });
  } catch (error) {
    console.error("Error fetching researchers:", error);
    res.status(500).json({ error: "Failed to fetch researchers" });
  }
});

router.get("/recommendations/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Check cache first - return cached data if available
    const cached = getRecommendationsCache(userId);
    if (cached) {
      return res.json(cached);
    }

    const profile = await Profile.findOne({ userId });
    let topics = [];
    if (profile?.role === "patient") {
      topics = profile?.patient?.conditions || [];
    } else if (profile?.role === "researcher") {
      // For researchers, use ALL interests (not just the first one)
      topics =
        profile?.researcher?.interests ||
        profile?.researcher?.specialties ||
        [];
    }

    // For researchers with multiple interests, combine them for better search results
    // Use first interest as primary, but include all in search queries
    const primaryTopic = topics[0] || "oncology";
    const allTopics = topics.length > 0 ? topics : [primaryTopic];

    // Combine all topics into a search query (e.g., "Neurology OR Alzheimer's Disease OR Neurodegeneration")
    const combinedQuery =
      allTopics.length > 1 ? allTopics.join(" OR ") : primaryTopic;

    // Extract user location
    const userLocation =
      profile?.patient?.location || profile?.researcher?.location;
    let locationForTrials = null;
    let locationStringForExperts = null;

    if (userLocation) {
      // For clinical trials API, use only country
      if (userLocation.country) {
        locationForTrials = userLocation.country;
      }

      // For experts query, format as "City, Country" or just "Country"
      const locationParts = [userLocation.city, userLocation.country].filter(
        Boolean
      );
      if (locationParts.length > 0) {
        locationStringForExperts = locationParts.join(", ");
      } else if (userLocation.country) {
        locationStringForExperts = userLocation.country;
      }
    }

    // Build search query for experts with location (can include city)
    // For multiple interests, use the combined query
    let globalExpertsQuery = combinedQuery;
    if (locationStringForExperts) {
      globalExpertsQuery = `${combinedQuery} in ${locationStringForExperts}`;
    } else {
      globalExpertsQuery = `${combinedQuery} global`;
    }

    // Build PubMed query without location (e.g., "Neurology OR Alzheimer's Disease")
    let pubmedQuery = combinedQuery;

    // Extract biomarkers from user profile (same as search route)
    let biomarkers = [];
    if (profile?.patient?.conditions) {
      const profileConditionsStr = profile.patient.conditions.join(" ");
      if (profileConditionsStr) {
        const profileBiomarkers = extractBiomarkers(profileConditionsStr);
        biomarkers = [...biomarkers, ...profileBiomarkers];
      }
    }
    if (profile?.patient?.keywords) {
      const profileKeywordsStr = profile.patient.keywords.join(" ");
      if (profileKeywordsStr) {
        const profileKeywordBiomarkers = extractBiomarkers(profileKeywordsStr);
        biomarkers = [...biomarkers, ...profileKeywordBiomarkers];
      }
    }
    // Remove duplicates
    biomarkers = [...new Set(biomarkers)];

    // Fetch a larger batch for trials (same as search route) - up to 500 results for sorting
    // This ensures we get top results sorted by match percentage
    const batchSize = 500;
    
    // Fetch all data in parallel for better performance
    // For trials, use the same logic as search route: fetch large batch, calculate matches, sort, then limit
    // Wrap each promise with error handling to prevent crashes
    const [trialsResult, publicationsResult, globalExperts] = await Promise.all(
      [
        searchClinicalTrials({
          q: primaryTopic,
          location: locationForTrials,
          status: "RECRUITING", // Keep RECRUITING filter for recommendations
          biomarkers, // Pass extracted biomarkers (same as search route)
          page: 1, // Always fetch from page 1 for the batch
          pageSize: batchSize, // Fetch larger batch for sorting
        }).catch((error) => {
          console.error("Error fetching clinical trials:", error);
          return { items: [], totalCount: 0, hasMore: false };
        }),
        // Fetch more publications to ensure we have at least 9 after filtering by abstract
        // Similar to search route, fetch a larger batch to account for filtering
        searchPubMed({ q: pubmedQuery, page: 1, pageSize: 50 }).catch((error) => {
          console.error("Error fetching PubMed publications:", error);
          return {
            items: [],
            totalCount: 0,
            page: 1,
            pageSize: 50,
            hasMore: false,
          };
        }),
        // Fetch global experts using the same service as Experts.jsx
        findResearchersWithGemini(globalExpertsQuery).catch((error) => {
          console.error("Error fetching global experts:", error);
          // Return empty array on error, don't fail the entire request
          return [];
        }),
      ]
    );

    // Extract items from the result objects (both services return objects with items property)
    const allTrials = trialsResult?.items || [];
    // Filter out publications without abstracts
    const publications = (publicationsResult?.items || []).filter(
      (pub) => pub.abstract && pub.abstract.trim().length > 0
    );

    // Fetch local researchers (CuraLink Experts) instead of mocked experts

    let experts = [];
    try {
      const researcherProfiles = await Profile.find({ role: "researcher" })
        .populate("userId", "username email")
        .lean();

      experts = researcherProfiles
        .filter((p) => {
          // Exclude current user if they are a researcher
          if (
            profile?.role === "researcher" &&
            p.userId?._id?.toString() === userId
          ) {
            return false;
          }
          // Only include verified experts
          return p.userId && p.researcher && p.researcher.isVerified === true;
        })
        .map((profile) => {
          const user = profile.userId;
          const researcher = profile.researcher || {};
          return {
            _id: profile.userId._id || profile.userId.id,
            userId: profile.userId._id || profile.userId.id,
            name: user.username || "Unknown Researcher",
            email: user.email,
            orcid: researcher.orcid || null,
            bio: researcher.bio || null,
            location: researcher.location || null,
            specialties: researcher.specialties || [],
            interests: researcher.interests || [],
            available: researcher.available || false,
            isVerified: researcher.isVerified || false,
          };
        });
    } catch (error) {
      console.error("Error fetching experts:", error);
      // Fallback to empty array if error
      experts = [];
    }

    // Calculate match percentages for all trials (same as search route)
    const trialsWithMatch = allTrials.map((trial) => {
      const match = calculateTrialMatch(trial, profile);
      return {
        ...trial,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    // Sort trials by match percentage (descending) - same as search route
    const sortedTrials = trialsWithMatch.sort(
      (a, b) => (b.matchPercentage || -1) - (a.matchPercentage || -1)
    );

    // Limit to top 9 trials (for recommendations)
    const topTrials = sortedTrials.slice(0, 9);

    // Simplify titles only for the top 9 trials (same approach as search route)
    let trialsWithSimplifiedTitles;
    try {
      const simplifiedTitles = await batchSimplifyTrialTitles(topTrials);
      trialsWithSimplifiedTitles = topTrials.map((trial, index) => ({
        ...trial,
        simplifiedTitle: simplifiedTitles[index] || trial.title,
      }));
    } catch (error) {
      // If batch simplification fails, fallback to original titles
      console.error("Error batch simplifying trial titles:", error);
      trialsWithSimplifiedTitles = topTrials.map((trial) => ({
        ...trial,
        simplifiedTitle: trial.title,
      }));
    }

    const publicationsWithMatch = publications.map((pub) => {
      const match = calculatePublicationMatch(pub, profile);
      return {
        ...pub,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    // Sort publications by match percentage (descending) and limit to top 9 matches
    // This matches the pattern used for trials and ensures we show at least 9 top matches
    // Similar to how the search route handles top results
    const sortedPublications = publicationsWithMatch
      .sort((a, b) => (b.matchPercentage || 0) - (a.matchPercentage || 0))
      .slice(0, 9); // Limit to top 9 publications with highest match percentage

    const expertsWithMatch = experts.map((expert) => {
      const match = calculateExpertMatch(expert, profile);
      return {
        ...expert,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    const globalExpertsWithMatch = (globalExperts || []).map((expert) => {
      const match = calculateExpertMatch(expert, profile);
      return {
        ...expert,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    // Build the complete recommendations response
    const recommendations = {
      trials: trialsWithSimplifiedTitles, // Use trials with simplified titles
      publications: sortedPublications, // Use sorted publications instead of unsorted
      experts: expertsWithMatch,
      globalExperts: globalExpertsWithMatch,
    };

    // Cache the recommendations for this user
    setRecommendationsCache(userId, recommendations);

    res.json(recommendations);
  } catch (error) {
    console.error("Error in /recommendations/:userId route:", error);
    res.status(500).json({
      error: "Failed to fetch recommendations",
      message: error.message,
    });
  }
});

// DELETE endpoint to clear cache for a specific user
// This should be called when a user updates their profile
router.delete("/recommendations/cache/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const key = `recommendations:${userId}`;
    const hadCache = recommendationsCache.has(key);
    recommendationsCache.delete(key);

    res.json({
      success: true,
      message: hadCache
        ? "Cache cleared successfully"
        : "No cache found for user",
      cleared: hadCache,
    });
  } catch (error) {
    console.error("Error clearing cache:", error);
    res.status(500).json({ error: "Failed to clear cache" });
  }
});

export default router;
