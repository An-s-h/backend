import { Router } from "express";
import mongoose from "mongoose";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { Community } from "../models/Community.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { fetchFullORCIDProfile } from "../services/orcid.service.js";
import { verifySession } from "../middleware/auth.js";

const router = Router();

// ResearchGate: exact hostnames
const RESEARCHGATE_HOSTS = ["researchgate.net", "www.researchgate.net"];
// Academia.edu: allow academia.edu and *.academia.edu (e.g. sohag-univ.academia.edu, www.academia.edu)
const ACADEMIA_DOMAIN_SUFFIX = ".academia.edu";
const ACADEMIA_REGEX = /^https?:\/\/(www\.)?([a-z0-9-]+\.)?academia\.edu\/[A-Za-z0-9._-]+$/i;

function validateAcademicUrl(url) {
  if (!url || typeof url !== "string") return { valid: false, platform: null, normalizedUrl: null };
  let normalized = url.trim();
  if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) normalized = "https://" + normalized;
  let hostname;
  try {
    hostname = new URL(normalized).hostname.toLowerCase();
  } catch {
    return { valid: false, platform: null, normalizedUrl: null };
  }
  // ResearchGate: allowlist
  if (RESEARCHGATE_HOSTS.includes(hostname)) {
    return { valid: true, platform: "researchgate", normalizedUrl: normalized };
  }
  // Academia.edu: allow academia.edu and *.academia.edu
  if (hostname === "academia.edu" || hostname.endsWith(ACADEMIA_DOMAIN_SUFFIX)) {
    if (!ACADEMIA_REGEX.test(normalized)) return { valid: false, platform: null, normalizedUrl: null };
    return { valid: true, platform: "academia", normalizedUrl: normalized };
  }
  return { valid: false, platform: null, normalizedUrl: null };
}

// GET /api/profile/:userId/forum-profile — public forum profile: name, username, forums posted, communities joined (for user profile modal)
router.get("/profile/:userId/forum-profile", async (req, res) => {
  try {
    const { userId } = req.params;
    const uid = new mongoose.Types.ObjectId(userId);

    const user = await User.findById(uid).select("username handle picture role").lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Forums they have posted in (threads authored by this user; include community/subcategory context)
    const threads = await Thread.find({ authorUserId: uid, isResearcherForum: false })
      .populate("communityId", "name slug")
      .populate("subcategoryId", "name slug")
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const forumsPosted = threads.map((t) => ({
      _id: t._id,
      title: t.title,
      community: t.communityId ? { name: t.communityId.name, slug: t.communityId.slug } : null,
      subcategory: t.subcategoryId ? { name: t.subcategoryId.name } : null,
      createdAt: t.createdAt,
    }));

    // Communities they have joined
    const memberships = await CommunityMembership.find({ userId: uid })
      .populate("communityId", "name slug color")
      .lean();

    const communitiesJoined = (memberships || [])
      .filter((m) => m.communityId)
      .map((m) => ({
        _id: m.communityId._id,
        name: m.communityId.name,
        slug: m.communityId.slug,
        color: m.communityId.color,
      }));

    res.json({
      user: {
        _id: user._id,
        username: user.username,
        handle: user.handle,
        picture: user.picture,
        role: user.role,
        displayName: user.handle || user.username || "User",
      },
      forumsPosted,
      communitiesJoined,
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid user ID" });
    console.error("Error fetching forum profile:", err);
    res.status(500).json({ error: "Failed to load profile" });
  }
});

// GET /api/profile/:userId
router.get("/profile/:userId", async (req, res) => {
  const { userId } = req.params;
  const profile = await Profile.findOne({ userId });
  return res.json({ profile });
});

// POST /api/profile/link-academic — must be before /profile/:userId so "link-academic" is not captured as userId
router.post("/profile/link-academic", verifySession, async (req, res) => {
  try {
    const { url } = req.body || {};
    const user = req.user;
    if (!user) return res.status(401).json({ error: "Authentication required" });
    if (!url || !url.trim()) return res.status(400).json({ error: "URL is required" });

    const validation = validateAcademicUrl(url.trim());
    if (!validation.valid)
      return res.status(400).json({ error: "Invalid URL. Use a ResearchGate or Academia.edu profile link." });

    const profile = await Profile.findOne({ userId: user._id });
    if (!profile || profile.role !== "researcher")
      return res.status(403).json({ error: "Only researchers can link academic profiles" });

    const update = {};
    if (validation.platform === "researchgate") {
      update["researcher.researchGate"] = validation.normalizedUrl;
      update["researcher.researchGateVerification"] = "pending";
    } else {
      update["researcher.academiaEdu"] = validation.normalizedUrl;
      update["researcher.academiaEduVerification"] = "pending";
    }
    await Profile.findOneAndUpdate({ userId: user._id }, { $set: update }, { new: true });

    return res.json({
      ok: true,
      saved: true,
      status: "pending",
      platform: validation.platform,
      normalizedUrl: validation.normalizedUrl,
      message: "Your profile will be reviewed by a moderator and verified.",
    });
  } catch (err) {
    console.error("link-academic error:", err);
    return res.status(500).json({ error: err.message || "Failed to save link" });
  }
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

// PUT /api/profile/:userId (same as POST for frontend compatibility)
router.put("/profile/:userId", async (req, res) => {
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

// GET /api/collabiora-expert/profile/:userId - Get Collabiora expert profile with ORCID data and forums
router.get("/collabiora-expert/profile/:userId", async (req, res) => {
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
      researchGate: researcher.researchGate || null,
      researchGateVerification: researcher.researchGateVerification || null,
      academiaEdu: researcher.academiaEdu || null,
      academiaEduVerification: researcher.academiaEduVerification || null,
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
            totalWorks:
              orcidProfileData.totalWorks ||
              orcidProfileData.publications?.length ||
              0,
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

    // Fetch forums where expert has participated (replied to)
    // Convert userId to ObjectId for proper matching (handle both string and ObjectId)
    let userIdObjectId;
    if (mongoose.Types.ObjectId.isValid(userId)) {
      userIdObjectId = new mongoose.Types.ObjectId(userId);
    } else {
      userIdObjectId = userId; // Fallback if not valid ObjectId
    }

    // Find all replies by this expert
    const expertReplies = await Reply.find({
      $or: [
        { authorUserId: userIdObjectId },
        { authorUserId: userId }, // Also try string version for compatibility
      ],
    })
      .select("threadId")
      .lean();

    // Get unique thread IDs
    const participatedThreadIds = [
      ...new Set(expertReplies.map((reply) => reply.threadId.toString())),
    ];

    // If no replies found, set empty array
    if (participatedThreadIds.length === 0) {
      profileData.participatedForums = [];
      profileData.totalParticipatedForums = 0;
    } else {
      // Convert thread IDs to ObjectIds for query
      const threadObjectIds = participatedThreadIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

      // Fetch threads where expert has participated (INCLUDE all forums where they replied, even if they created them)
      const participatedForums =
        threadObjectIds.length > 0
          ? await Thread.find({
              _id: { $in: threadObjectIds },
            })
              .populate("categoryId", "name slug")
              .populate("authorUserId", "username email")
              .sort({ createdAt: -1 })
              .limit(20)
              .lean()
          : [];

      // Get reply counts for participated forums
      const participatedForumIds = participatedForums.map((f) => f._id);
      const participatedReplyCounts =
        participatedForumIds.length > 0
          ? await Reply.aggregate([
              { $match: { threadId: { $in: participatedForumIds } } },
              { $group: { _id: "$threadId", count: { $sum: 1 } } },
            ])
          : [];

      const participatedCountMap = {};
      participatedReplyCounts.forEach((item) => {
        participatedCountMap[item._id.toString()] = item.count;
      });

      // Get count of expert's replies in each participated forum
      const expertReplyCounts =
        participatedForumIds.length > 0
          ? await Reply.aggregate([
              {
                $match: {
                  threadId: { $in: participatedForumIds },
                  $or: [
                    { authorUserId: userIdObjectId },
                    { authorUserId: userId }, // Also try string version for compatibility
                  ],
                },
              },
              { $group: { _id: "$threadId", count: { $sum: 1 } } },
            ])
          : [];

      const expertReplyCountMap = {};
      expertReplyCounts.forEach((item) => {
        expertReplyCountMap[item._id.toString()] = item.count;
      });

      // Format participated forums for frontend
      const formattedParticipatedForums = participatedForums.map((forum) => ({
        _id: forum._id,
        categoryId: forum.categoryId?._id || forum.categoryId,
        categoryName: forum.categoryId?.name || "Uncategorized",
        authorUserId: forum.authorUserId?._id || forum.authorUserId,
        authorUsername: forum.authorUserId?.username || "Unknown",
        title: forum.title,
        body: forum.body,
        upvotes: forum.upvotes?.length || 0,
        downvotes: forum.downvotes?.length || 0,
        voteScore:
          (forum.upvotes?.length || 0) - (forum.downvotes?.length || 0),
        replyCount: participatedCountMap[forum._id.toString()] || 0,
        expertReplyCount: expertReplyCountMap[forum._id.toString()] || 0, // Number of replies by this expert
        isCreator:
          forum.authorUserId?._id?.toString() === userId ||
          forum.authorUserId?.toString() === userId, // Whether expert created this forum
        viewCount: forum.viewCount || 0,
        createdAt: forum.createdAt,
        updatedAt: forum.updatedAt,
      }));

      // Add participated forums to profile data
      profileData.participatedForums = formattedParticipatedForums;
      profileData.totalParticipatedForums = formattedParticipatedForums.length;
    }

    res.json({ profile: profileData });
  } catch (error) {
    console.error("Error fetching CuraLink expert profile:", error);
    res.status(500).json({ error: "Failed to fetch CuraLink expert profile" });
  }
});

export default router;
