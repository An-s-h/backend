import { Router } from "express";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { searchClinicalTrials } from "../services/clinicalTrials.service.js";
import { searchPubMed } from "../services/pubmed.service.js";
import { findDeterministicExperts } from "../services/deterministicExperts.service.js";
import {
  calculateTrialMatch,
  calculatePublicationMatch,
  calculateExpertMatch,
} from "../services/matching.service.js";
import { extractBiomarkers } from "../services/medicalTerminology.service.js";
import { batchSimplifyTrialTitles } from "../services/trialSimplification.service.js";
import { batchSimplifyPublicationTitles } from "../services/summary.service.js";
import {
  getRecommendationsCache,
  setRecommendationsCache,
  clearRecommendationsCache,
} from "../services/recommendationsCache.js";

const router = Router();

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
      const indices = profile?.patient?.primaryConditionIndices;
      if (
        Array.isArray(indices) &&
        indices.length >= 1 &&
        indices.length <= 2 &&
        topics.length > 0
      ) {
        const selected = indices
          .filter((i) => i >= 0 && i < topics.length)
          .map((i) => topics[i])
          .filter(Boolean);
        if (selected.length > 0) topics = selected;
      }
    } else if (profile?.role === "researcher") {
      topics =
        profile?.researcher?.interests ||
        profile?.researcher?.specialties ||
        [];
      const indices = profile?.researcher?.primaryInterestIndices;
      if (
        Array.isArray(indices) &&
        indices.length >= 1 &&
        indices.length <= 2 &&
        topics.length > 0
      ) {
        const selected = indices
          .filter((i) => i >= 0 && i < topics.length)
          .map((i) => topics[i])
          .filter(Boolean);
        if (selected.length > 0) topics = selected;
      }
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

      // For experts query, format as "City, State/Province, Country"
      const locationParts = [
        userLocation.city,
        userLocation.state,
        userLocation.country,
      ].filter(Boolean);
      if (locationParts.length > 0) {
        locationStringForExperts = locationParts.join(", ");
      } else if (userLocation.country) {
        locationStringForExperts = userLocation.country;
      }
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

    // Dashboard: publications from last 3 months only; trials from last 3 months and RECRUITING
    const dashboardPublicationsMonths = 3;
    const dashboardTrialsMonths = 3;
    const cutoffPub = new Date();
    cutoffPub.setMonth(cutoffPub.getMonth() - dashboardPublicationsMonths);
    const pubMindate = `${cutoffPub.getFullYear()}/${String(cutoffPub.getMonth() + 1).padStart(2, "0")}`;

    // Fetch all data in parallel for better performance
    // For trials, use the same logic as search route: fetch large batch, calculate matches, sort, then limit
    // Wrap each promise with error handling to prevent crashes
    const [trialsResult, publicationsResult, globalExperts] = await Promise.all(
      [
        searchClinicalTrials({
          q: primaryTopic,
          location: locationForTrials,
          status: "RECRUITING", // Dashboard default: recruiting only
          biomarkers, // Pass extracted biomarkers (same as search route)
          page: 1, // Always fetch from page 1 for the batch
          pageSize: batchSize, // Fetch larger batch for sorting
          recentMonths: dashboardTrialsMonths, // Dashboard: only trials updated in last 3 months
        }).catch((error) => {
          console.error("Error fetching clinical trials:", error);
          return { items: [], totalCount: 0, hasMore: false };
        }),
        // Dashboard: publications from last 3 months only (mindate so only specified timeline)
        searchPubMed({
          q: pubmedQuery,
          mindate: pubMindate,
          maxdate: "",
          page: 1,
          pageSize: 50,
        }).catch(
          (error) => {
            console.error("Error fetching PubMed publications:", error);
            return {
              items: [],
              totalCount: 0,
              page: 1,
              pageSize: 50,
              hasMore: false,
            };
          },
        ),
        // Fetch global experts using deterministic approach (dashboard: limit OpenAlex to top 100 for speed + skip AI summaries)
        findDeterministicExperts(
          primaryTopic, // Use primary topic (first interest)
          locationStringForExperts || null, // Pass location separately (not in query string)
          1, // page 1
          6, // Fetch 6 experts for recommendations
          {
            limitOpenAlexProfiles: true, // Dashboard only: fetch top 100 authors for faster load
            skipAISummaries: true, // Dashboard only: skip AI summary generation for much faster load
          },
        ).catch((error) => {
          console.error("Error fetching global experts:", error);
          // Return empty array on error, don't fail the entire request
          return {
            experts: [],
            totalFound: 0,
            page: 1,
            pageSize: 6,
            hasMore: false,
          };
        }),
      ],
    );

    // Extract items from the result objects (both services return objects with items property)
    const allTrials = trialsResult?.items || [];
    // Filter out publications without abstracts
    const publications = (publicationsResult?.items || []).filter(
      (pub) => pub.abstract && pub.abstract.trim().length > 0,
    );
    // Extract experts array from deterministic result (returns { experts, totalFound, ... })
    const globalExpertsList = globalExperts?.experts || [];

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
      (a, b) => (b.matchPercentage || -1) - (a.matchPercentage || -1),
    );

    // Limit to top 9 trials (for recommendations)
    const topTrials = sortedTrials.slice(0, 9);

    // Simplify titles only for patients (researchers see original titles)
    const isResearcher = profile?.role === "researcher";
    let trialsWithSimplifiedTitles;
    if (isResearcher) {
      trialsWithSimplifiedTitles = topTrials.map((trial) => ({
        ...trial,
        simplifiedTitle: trial.title,
      }));
    } else {
      try {
        const simplifiedTitles = await batchSimplifyTrialTitles(topTrials);
        trialsWithSimplifiedTitles = topTrials.map((trial, index) => ({
          ...trial,
          simplifiedTitle: simplifiedTitles[index] || trial.title,
        }));
      } catch (error) {
        console.error("Error batch simplifying trial titles:", error);
        trialsWithSimplifiedTitles = topTrials.map((trial) => ({
          ...trial,
          simplifiedTitle: trial.title,
        }));
      }
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

    // Simplify publication titles for patients (same as Publications page / search route)
    let publicationsWithSimplifiedTitles = sortedPublications;
    if (!isResearcher) {
      try {
        const pubTitles = sortedPublications.map((p) => p.title || "");
        const simplifiedPubTitles =
          await batchSimplifyPublicationTitles(pubTitles);
        publicationsWithSimplifiedTitles = sortedPublications.map(
          (pub, index) => ({
            ...pub,
            simplifiedTitle:
              simplifiedPubTitles[index] || pub.title || "Untitled Publication",
          }),
        );
      } catch (error) {
        console.error("Error batch simplifying publication titles:", error);
        publicationsWithSimplifiedTitles = sortedPublications.map((pub) => ({
          ...pub,
          simplifiedTitle: pub.title || "Untitled Publication",
        }));
      }
    } else {
      publicationsWithSimplifiedTitles = sortedPublications.map((pub) => ({
        ...pub,
        simplifiedTitle: pub.title || "Untitled Publication",
      }));
    }

    const expertsWithMatch = experts.map((expert) => {
      const match = calculateExpertMatch(expert, profile);
      return {
        ...expert,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });

    const globalExpertsWithMatch = (globalExpertsList || []).map((expert) => {
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
      publications: publicationsWithSimplifiedTitles, // Use publications with simplified titles (patients)
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
    const hadCache = clearRecommendationsCache(userId);

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

// GET /recommendations/:userId/section?type=trials|publications|experts
// Fetches only one section (no cache) for dashboard refresh: active section first, others in background.
router.get("/recommendations/:userId/section", async (req, res) => {
  try {
    const { userId } = req.params;
    const type = (req.query.type || "").toLowerCase();
    if (!["trials", "publications", "experts"].includes(type)) {
      return res.status(400).json({
        error: "Invalid type",
        message: "type must be one of: trials, publications, experts",
      });
    }

    const profile = await Profile.findOne({ userId }).lean();
    let topics = [];
    if (profile?.role === "patient") {
      topics = profile?.patient?.conditions || [];
      const indices = profile?.patient?.primaryConditionIndices;
      if (
        Array.isArray(indices) &&
        indices.length >= 1 &&
        indices.length <= 2 &&
        topics.length > 0
      ) {
        const selected = indices
          .filter((i) => i >= 0 && i < topics.length)
          .map((i) => topics[i])
          .filter(Boolean);
        if (selected.length > 0) topics = selected;
      }
    } else if (profile?.role === "researcher") {
      topics =
        profile?.researcher?.interests ||
        profile?.researcher?.specialties ||
        [];
      const indices = profile?.researcher?.primaryInterestIndices;
      if (
        Array.isArray(indices) &&
        indices.length >= 1 &&
        indices.length <= 2 &&
        topics.length > 0
      ) {
        const selected = indices
          .filter((i) => i >= 0 && i < topics.length)
          .map((i) => topics[i])
          .filter(Boolean);
        if (selected.length > 0) topics = selected;
      }
    }
    const primaryTopic = topics[0] || "oncology";
    const combinedQuery =
      topics.length > 1 ? topics.join(" OR ") : primaryTopic;

    const userLocation =
      profile?.patient?.location || profile?.researcher?.location;
    let locationForTrials = null;
    let locationStringForExperts = null;
    if (userLocation) {
      if (userLocation.country) locationForTrials = userLocation.country;
      const locationParts = [
        userLocation.city,
        userLocation.state,
        userLocation.country,
      ].filter(Boolean);
      locationStringForExperts =
        locationParts.length > 0
          ? locationParts.join(", ")
          : userLocation.country || null;
    }

    let biomarkers = [];
    if (profile?.patient?.conditions) {
      const s = profile.patient.conditions.join(" ");
      if (s) biomarkers.push(...extractBiomarkers(s));
    }
    if (profile?.patient?.keywords) {
      const s = profile.patient.keywords.join(" ");
      if (s) biomarkers.push(...extractBiomarkers(s));
    }
    biomarkers = [...new Set(biomarkers)];

    const batchSize = 500;
    const dashboardPublicationsMonths = 3;
    const dashboardTrialsMonths = 3;
    const cutoffPub = new Date();
    cutoffPub.setMonth(cutoffPub.getMonth() - dashboardPublicationsMonths);
    const pubMindate = `${cutoffPub.getFullYear()}/${String(cutoffPub.getMonth() + 1).padStart(2, "0")}`;
    const isResearcher = profile?.role === "researcher";

    if (type === "trials") {
      const trialsResult = await searchClinicalTrials({
        q: primaryTopic,
        location: locationForTrials,
        status: "RECRUITING",
        biomarkers,
        page: 1,
        pageSize: batchSize,
        recentMonths: dashboardTrialsMonths,
      }).catch((err) => {
        console.error("Error fetching trials section:", err);
        return { items: [], totalCount: 0, hasMore: false };
      });
      const allTrials = trialsResult?.items || [];
      const trialsWithMatch = allTrials.map((trial) => {
        const match = calculateTrialMatch(trial, profile);
        return {
          ...trial,
          matchPercentage: match.matchPercentage,
          matchExplanation: match.matchExplanation,
        };
      });
      const sortedTrials = trialsWithMatch.sort(
        (a, b) => (b.matchPercentage || -1) - (a.matchPercentage || -1),
      );
      const topTrials = sortedTrials.slice(0, 9);
      let trialsWithSimplifiedTitles;
      if (isResearcher) {
        trialsWithSimplifiedTitles = topTrials.map((t) => ({
          ...t,
          simplifiedTitle: t.title,
        }));
      } else {
        try {
          const simplifiedTitles = await batchSimplifyTrialTitles(topTrials);
          trialsWithSimplifiedTitles = topTrials.map((t, i) => ({
            ...t,
            simplifiedTitle: simplifiedTitles[i] || t.title,
          }));
        } catch {
          trialsWithSimplifiedTitles = topTrials.map((t) => ({
            ...t,
            simplifiedTitle: t.title,
          }));
        }
      }
      return res.json({ trials: trialsWithSimplifiedTitles });
    }

    if (type === "publications") {
      const publicationsResult = await searchPubMed({
        q: combinedQuery,
        mindate: pubMindate,
        maxdate: "",
        page: 1,
        pageSize: 50,
      }).catch((err) => {
        console.error("Error fetching publications section:", err);
        return {
          items: [],
          totalCount: 0,
          page: 1,
          pageSize: 50,
          hasMore: false,
        };
      });
      const publications = (publicationsResult?.items || []).filter(
        (pub) => pub.abstract && pub.abstract.trim().length > 0,
      );
      const publicationsWithMatch = publications.map((pub) => {
        const match = calculatePublicationMatch(pub, profile);
        return {
          ...pub,
          matchPercentage: match.matchPercentage,
          matchExplanation: match.matchExplanation,
        };
      });
      const sortedPublications = publicationsWithMatch
        .sort((a, b) => (b.matchPercentage || 0) - (a.matchPercentage || 0))
        .slice(0, 9);
      let publicationsWithSimplifiedTitles = sortedPublications;
      if (!isResearcher) {
        try {
          const pubTitles = sortedPublications.map((p) => p.title || "");
          const simplifiedPubTitles =
            await batchSimplifyPublicationTitles(pubTitles);
          publicationsWithSimplifiedTitles = sortedPublications.map((p, i) => ({
            ...p,
            simplifiedTitle:
              simplifiedPubTitles[i] || p.title || "Untitled Publication",
          }));
        } catch {
          publicationsWithSimplifiedTitles = sortedPublications.map((p) => ({
            ...p,
            simplifiedTitle: p.title || "Untitled Publication",
          }));
        }
      } else {
        publicationsWithSimplifiedTitles = sortedPublications.map((p) => ({
          ...p,
          simplifiedTitle: p.title || "Untitled Publication",
        }));
      }
      return res.json({ publications: publicationsWithSimplifiedTitles });
    }

    // type === "experts"
    const [globalExperts, researcherProfiles] = await Promise.all([
      findDeterministicExperts(
        primaryTopic,
        locationStringForExperts || null,
        1,
        6,
        {
          limitOpenAlexProfiles: true,
          skipAISummaries: true,
        },
      ).catch((err) => {
        console.error("Error fetching global experts section:", err);
        return {
          experts: [],
          totalFound: 0,
          page: 1,
          pageSize: 6,
          hasMore: false,
        };
      }),
      Profile.find({ role: "researcher" })
        .populate("userId", "username email")
        .lean(),
    ]);

    const globalExpertsList = globalExperts?.experts || [];
    let experts = (researcherProfiles || [])
      .filter((p) => {
        if (
          profile?.role === "researcher" &&
          p.userId?._id?.toString() === userId
        )
          return false;
        return p.userId && p.researcher && p.researcher.isVerified === true;
      })
      .map((p) => {
        const user = p.userId;
        const researcher = p.researcher || {};
        return {
          _id: p.userId._id || p.userId.id,
          userId: p.userId._id || p.userId.id,
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

    const expertsWithMatch = experts.map((expert) => {
      const match = calculateExpertMatch(expert, profile);
      return {
        ...expert,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });
    const globalExpertsWithMatch = (globalExpertsList || []).map((expert) => {
      const match = calculateExpertMatch(expert, profile);
      return {
        ...expert,
        matchPercentage: match.matchPercentage,
        matchExplanation: match.matchExplanation,
      };
    });
    return res.json({
      experts: expertsWithMatch,
      globalExperts: globalExpertsWithMatch,
    });
  } catch (error) {
    console.error("Error in /recommendations/:userId/section:", error);
    res.status(500).json({
      error: "Failed to fetch section",
      message: error.message,
    });
  }
});

export default router;
