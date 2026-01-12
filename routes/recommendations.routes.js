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
    for (const [k, v] of recommendationsCache.entries()) {
      if (now > v.expires) {
        recommendationsCache.delete(k);
      }
    }
  }
}

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
        profile?.researcher?.interests || profile?.researcher?.specialties || [];
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

    // For clinical trials, search with combined query but also try individual searches
    // to get more diverse results
    const trialSearches =
      allTopics.length > 1
        ? [combinedQuery, ...allTopics.slice(0, 3)] // Limit to avoid too many API calls
        : [primaryTopic];

    // Fetch all data in parallel for better performance
    // For trials, search with primary topic and filter for RECRUITING status only
    // Wrap each promise with error handling to prevent crashes
    const [trials, publicationsResult, globalExperts] = await Promise.all([
      searchClinicalTrials({ q: primaryTopic, location: locationForTrials, status: "RECRUITING" }).catch((error) => {
        console.error("Error fetching clinical trials:", error);
        return [];
      }),
      searchPubMed({ q: pubmedQuery }).catch((error) => {
        console.error("Error fetching PubMed publications:", error);
        return { items: [], totalCount: 0, page: 1, pageSize: 9, hasMore: false };
      }),
      // Fetch global experts using the same service as Experts.jsx
      findResearchersWithGemini(globalExpertsQuery).catch((error) => {
        console.error("Error fetching global experts:", error);
        // Return empty array on error, don't fail the entire request
        return [];
      }),
    ]);

    // Extract publications items from the result object
    const publications = publicationsResult?.items || [];

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

    // Calculate match percentages for all items
    const trialsWithMatch = (trials || []).map((trial) => {
      const match = calculateTrialMatch(trial, profile);
      return {
        ...trial,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    // Sort trials by match percentage (descending) and limit to 9
    const sortedTrials = trialsWithMatch
      .sort((a, b) => (b.matchPercentage || 0) - (a.matchPercentage || 0))
      .slice(0, 9);

    const publicationsWithMatch = publications.map((pub) => {
      const match = calculatePublicationMatch(pub, profile);
      return {
        ...pub,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

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
      trials: sortedTrials,
      publications: publicationsWithMatch,
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
