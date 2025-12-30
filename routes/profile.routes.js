import { Router } from "express";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { fetchFullORCIDProfile } from "../services/orcid.service.js";

const router = Router();

// GET /api/profile/:userId
router.get("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const profile = await Profile.findOne({ userId });
  return res.json({ profile });
});

// POST /api/profile/:userId
router.post("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const payload = req.body || {};
  if (!payload.role) return res.status(400).json({ error: "role is required" });
  const doc = await Profile.findOneAndUpdate(
    { userId },
    { ...payload, userId },
    { new: true, upsert: true }
  );
  return res.json({ ok: true, profile: doc });
});

// GET /api/curalink-expert/profile/:userId - Get CuraLink expert profile with ORCID data and forums
router.get("/curalink-expert/profile/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { currentUserId } = req.query; // For checking follow/favorite status

    // Fetch profile from database
    const profile = await Profile.findOne({ userId })
      .populate("userId", "username email")
      .lean();

    if (!profile || profile.role !== "researcher") {
      return res.status(404).json({ error: "CuraLink expert not found" });
    }

    const user = profile.userId;
    const researcher = profile.researcher || {};

    // Base profile data from database
    let profileData = {
      _id: user._id || user.id,
      userId: user._id || user.id,
      name: user.username || "Unknown Researcher",
      email: user.email,
      orcid: researcher.orcid || null,
      bio: researcher.bio || null,
      location: researcher.location || null,
      specialties: researcher.specialties || [],
      interests: researcher.interests || [],
      available: researcher.available || false,
      isVerified: researcher.isVerified || false,
      onCuraLink: true, // They are on CuraLink
      contactable: true, // They can be contacted (via message request)
    };

    // If ORCID exists, fetch ORCID profile data
    if (researcher.orcid) {
      try {
        // Normalize ORCID ID (remove spaces, ensure proper format)
        const normalizedOrcid = researcher.orcid.trim().replace(/\s+/g, "");
        const orcidProfileData = await fetchFullORCIDProfile(normalizedOrcid);
        if (orcidProfileData) {
          // Merge ALL ORCID data with database data (keep database name, ORCID takes precedence for other fields)
          profileData = {
            ...profileData,
            // Keep database name - don't use ORCID name
            name: profileData.name,
            // Use ORCID biography if available, otherwise use database bio
            biography: orcidProfileData.biography || researcher.bio || null,
            bio: orcidProfileData.biography || researcher.bio || null,
            // Use ORCID affiliation if available
            affiliation: orcidProfileData.affiliation || null,
            // Use ORCID location if available
            location: orcidProfileData.location || researcher.location || null,
            // Merge research interests from ORCID with database interests
            researchInterests: [
              ...new Set([
                ...(orcidProfileData.researchInterests || []),
                ...(researcher.interests || []),
                ...(researcher.specialties || []),
              ]),
            ],
            // Add ORCID-specific data - include ALL extracted fields
            email: orcidProfileData.email || user.email,
            currentPosition: orcidProfileData.currentPosition || null,
            education: orcidProfileData.education || null,
            age: orcidProfileData.age || null,
            yearsOfExperience: orcidProfileData.yearsOfExperience || null,
            achievements: orcidProfileData.achievements || null,
            // Specialties from ORCID (AI-extracted) or from database
            specialties:
              orcidProfileData.specialties?.length > 0
                ? orcidProfileData.specialties
                : researcher.specialties || [],
            // Areas of expertise (same as specialties/research interests, formatted for frontend)
            areasOfExpertise: [
              ...new Set([
                ...(orcidProfileData.specialties || []),
                ...(orcidProfileData.researchInterests || []),
                ...(researcher.specialties || []),
                ...(researcher.interests || []),
              ]),
            ].slice(0, 10), // Limit to top 10
            // Keep ORCID ID for reference
            orcidId: orcidProfileData.orcidId || normalizedOrcid,
            // Add works/publications from ORCID
            works: orcidProfileData.works || [],
            publications: orcidProfileData.works || [], // Alias for works
            // Add impact metrics
            impactMetrics: orcidProfileData.impactMetrics || {
              totalPublications: orcidProfileData.publications?.length || 0,
              hIndex: 0,
              totalCitations: 0,
              maxCitations: 0,
            },
            // Add all other ORCID data (note: researchInterests already merged above)
            externalLinks: orcidProfileData.externalLinks || {},
            // Additional ORCID data
            country: orcidProfileData.country || null,
            emails: orcidProfileData.emails || [],
            otherNames: orcidProfileData.otherNames || [],
            employments: orcidProfileData.employments || [],
            educations: orcidProfileData.educations || [],
            fundings: orcidProfileData.fundings || [],
            totalFundings: orcidProfileData.totalFundings || 0,
            totalPeerReviews: orcidProfileData.totalPeerReviews || 0,
            totalWorks: orcidProfileData.totalWorks || orcidProfileData.publications?.length || 0,
          };
        } else {
          // Even if fetchFullORCIDProfile returns null, still include publications count as 0
          profileData.publications = [];
          profileData.works = [];
          profileData.impactMetrics = {
            totalPublications: 0,
            hIndex: 0,
            totalCitations: 0,
            maxCitations: 0,
          };
        }
      } catch (error) {
        console.error("Error fetching ORCID profile:", error.message);
        // Continue with basic database info if ORCID fetch fails, but include empty arrays
        profileData.publications = [];
        profileData.works = [];
        profileData.impactMetrics = {
          totalPublications: 0,
          hIndex: 0,
          totalCitations: 0,
          maxCitations: 0,
        };
      }
    }

    // Fetch forums created by this expert
    const forums = await Thread.find({ authorUserId: userId })
      .populate("categoryId", "name slug")
      .populate("authorUserId", "username email")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    // Get reply counts for each forum
    const forumIds = forums.map((f) => f._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: forumIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);

    const countMap = {};
    replyCounts.forEach((item) => {
      countMap[item._id.toString()] = item.count;
    });

    // Format forums for frontend
    const formattedForums = forums.map((forum) => ({
      _id: forum._id,
      categoryId: forum.categoryId?._id || forum.categoryId,
      categoryName: forum.categoryId?.name || "Uncategorized",
      authorUserId: forum.authorUserId?._id || forum.authorUserId,
      authorUsername: forum.authorUserId?.username || "Unknown",
      title: forum.title,
      body: forum.body,
      upvotes: forum.upvotes?.length || 0,
      downvotes: forum.downvotes?.length || 0,
      voteScore: (forum.upvotes?.length || 0) - (forum.downvotes?.length || 0),
      replyCount: countMap[forum._id.toString()] || 0,
      viewCount: forum.viewCount || 0,
      createdAt: forum.createdAt,
      updatedAt: forum.updatedAt,
    }));

    // Add forums to profile data
    profileData.forums = formattedForums;
    profileData.totalForums = formattedForums.length;

    res.json({ profile: profileData });
  } catch (error) {
    console.error("Error fetching CuraLink expert profile:", error);
    res.status(500).json({ error: "Failed to fetch CuraLink expert profile" });
  }
});

export default router;
