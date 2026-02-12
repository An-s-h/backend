import { Router } from "express";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { fetchFullORCIDProfile } from "../services/orcid.service.js";
import { fetchPageMetadata } from "../services/adminPageMetadata.service.js";
import { SearchLimit } from "../models/SearchLimit.js";
import { ForumCategory } from "../models/ForumCategory.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { Community } from "../models/Community.js";
import { CommunityProposal } from "../models/CommunityProposal.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { Subcategory } from "../models/Subcategory.js";
import { Trial } from "../models/Trial.js";
import { WorkSubmission } from "../models/WorkSubmission.js";
import { uploadSingle } from "../middleware/upload.js";
import { uploadImage } from "../services/upload.service.js";

const router = Router();

// Middleware: verify JWT and require isAdmin claim (admin signs in via main /api/auth/login or OAuth)
const verifyAdmin = (req, res, next) => {
  const token =
    req.headers.authorization?.replace("Bearer ", "") ||
    req.headers["x-auth-token"] ||
    req.query.token;

  if (!token) {
    return res.status(401).json({ error: "Unauthorized. Admin access required." });
  }

  const secret = process.env.JWT_SECRET || "your-secret-key-change-in-production";
  try {
    const decoded = jwt.verify(token, secret);
    if (decoded.isAdmin !== true) {
      return res.status(401).json({ error: "Unauthorized. Admin access required." });
    }
    req.adminUserId = decoded.userId;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized. Admin access required." });
  }
};

// Get activity counts for a list of user IDs (threads, replies, posts, comments, communities)
async function getActivityCounts(userIds) {
  if (!userIds || userIds.length === 0) {
    return { threads: {}, replies: {}, posts: {}, comments: {}, communities: {} };
  }
  const ids = userIds.map((id) => (id && id.toString ? id.toString() : id));
  const objectIds = ids.map((id) => (typeof id === "string" ? new mongoose.Types.ObjectId(id) : id));

  const [threadCounts, replyCounts, postCounts, commentCounts, communityCounts] = await Promise.all([
    Thread.aggregate([
      { $match: { authorUserId: { $in: objectIds } } },
      { $group: { _id: "$authorUserId", count: { $sum: 1 } } },
    ]),
    Reply.aggregate([
      { $match: { authorUserId: { $in: objectIds } } },
      { $group: { _id: "$authorUserId", count: { $sum: 1 } } },
    ]),
    Post.aggregate([
      { $match: { authorUserId: { $in: objectIds } } },
      { $group: { _id: "$authorUserId", count: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { authorUserId: { $in: objectIds } } },
      { $group: { _id: "$authorUserId", count: { $sum: 1 } } },
    ]),
    CommunityMembership.aggregate([
      { $match: { userId: { $in: objectIds } } },
      { $group: { _id: "$userId", count: { $sum: 1 } } },
    ]),
  ]);

  const toMap = (arr) => {
    const m = {};
    arr.forEach((item) => {
      m[item._id.toString()] = item.count;
    });
    return m;
  };

  return {
    threads: toMap(threadCounts),
    replies: toMap(replyCounts),
    posts: toMap(postCounts),
    comments: toMap(commentCounts),
    communities: toMap(communityCounts),
  };
}

// Get all CuraLink experts (for admin dashboard) with activity stats
router.get("/admin/experts", verifyAdmin, async (req, res) => {
  try {
    const profiles = await Profile.find({ role: "researcher" })
      .populate("userId", "username email createdAt")
      .lean();

    const expertList = profiles.filter((p) => p.userId && p.researcher);
    const userIds = expertList.map((p) => p.userId._id || p.userId.id);
    const activity = await getActivityCounts(userIds);

    const experts = expertList.map((profile) => {
      const user = profile.userId;
      const researcher = profile.researcher || {};
      const uid = (user._id || user.id).toString();
      const researchGateVerification = researcher.researchGateVerification || null;
      const academiaEduVerification = researcher.academiaEduVerification || null;
      const needsAttention =
        (researcher.researchGate && researchGateVerification === "pending") ||
        (researcher.academiaEdu && academiaEduVerification === "pending");
      return {
        _id: user._id || user.id,
        userId: user._id || user.id,
        name: user.username || "Unknown Researcher",
        email: user.email,
        accountCreated: user.createdAt || null,
        orcid: researcher.orcid || null,
        verificationDocumentUrl: researcher.verificationDocumentUrl || null,
        researchGate: researcher.researchGate || null,
        researchGateVerification,
        academiaEdu: researcher.academiaEdu || null,
        academiaEduVerification,
        needsAttention,
        bio: researcher.bio || null,
        location: researcher.location || null,
        specialties: researcher.specialties || [],
        interests: researcher.interests || [],
        available: researcher.available || false,
        isVerified: researcher.isVerified || false,
        threadCount: activity.threads[uid] || 0,
        replyCount: activity.replies[uid] || 0,
        postCount: activity.posts[uid] || 0,
        commentCount: activity.comments[uid] || 0,
        communityCount: activity.communities[uid] || 0,
      };
    });

    res.json({ experts });
  } catch (error) {
    console.error("Error fetching experts for admin:", error);
    res.status(500).json({ error: "Failed to fetch experts" });
  }
});

// Update expert verification status (isVerified + academic links verified when admin clicks Verify)
router.patch("/admin/experts/:userId/verify", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isVerified } = req.body;

    if (typeof isVerified !== "boolean") {
      return res.status(400).json({ error: "isVerified must be a boolean" });
    }

    const profile = await Profile.findOne({ userId });
    if (!profile || profile.role !== "researcher") {
      return res.status(404).json({ error: "Expert not found" });
    }

    profile.researcher.isVerified = isVerified;
    // When admin verifies expert, also mark academic profiles as verified (name/publications checked by moderator)
    if (isVerified) {
      if (profile.researcher.researchGate) profile.researcher.researchGateVerification = "verified";
      if (profile.researcher.academiaEdu) profile.researcher.academiaEduVerification = "verified";
    } else {
      profile.researcher.researchGateVerification = null;
      profile.researcher.academiaEduVerification = null;
    }
    await profile.save();

    const uid = profile.userId?._id || profile.userId?.id || profile.userId || userId;
    res.json({
      success: true,
      message: `Expert ${isVerified ? "verified" : "unverified"} successfully`,
      expert: {
        userId: uid,
        isVerified: profile.researcher.isVerified,
        researchGateVerification: profile.researcher.researchGateVerification,
        academiaEduVerification: profile.researcher.academiaEduVerification,
      },
    });
  } catch (error) {
    console.error("Error updating expert verification:", error);
    res.status(500).json({ error: "Failed to update verification status" });
  }
});

// GET /api/admin/expert/:userId — full expert profile for admin (ORCID + ResearchGate/Academia metadata)
router.get("/admin/expert/:userId", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const profile = await Profile.findOne({ userId })
      .populate("userId", "username email createdAt")
      .lean();

    if (!profile || profile.role !== "researcher") {
      return res.status(404).json({ error: "Expert not found" });
    }

    const user = profile.userId;
    const researcher = profile.researcher || {};

    let profileData = {
      _id: user._id || user.id,
      userId: user._id || user.id,
      name: user.username || "Unknown Researcher",
      email: user.email,
      accountCreated: user.createdAt || null,
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
    };

    // ORCID: fetch full profile like collabiora-expert
    if (researcher.orcid) {
      try {
        const normalizedOrcid = researcher.orcid.trim().replace(/\s+/g, "");
        const orcidProfileData = await fetchFullORCIDProfile(normalizedOrcid);
        if (orcidProfileData) {
          profileData = {
            ...profileData,
            name: profileData.name,
            biography: orcidProfileData.biography || researcher.bio || null,
            bio: orcidProfileData.biography || researcher.bio || null,
            affiliation: orcidProfileData.affiliation || null,
            location: orcidProfileData.location || researcher.location || null,
            researchInterests: [
              ...new Set([
                ...(orcidProfileData.researchInterests || []),
                ...(researcher.interests || []),
                ...(researcher.specialties || []),
              ]),
            ],
            currentPosition: orcidProfileData.currentPosition || null,
            education: orcidProfileData.education || null,
            orcidId: orcidProfileData.orcidId || normalizedOrcid,
            works: orcidProfileData.works || [],
            publications: orcidProfileData.works || [],
            impactMetrics: orcidProfileData.impactMetrics || {
              totalPublications: orcidProfileData.publications?.length || 0,
              hIndex: 0,
              totalCitations: 0,
              maxCitations: 0,
            },
            country: orcidProfileData.country || null,
            employments: orcidProfileData.employments || [],
            educations: orcidProfileData.educations || [],
          };
        } else {
          profileData.publications = [];
          profileData.works = [];
          profileData.impactMetrics = { totalPublications: 0, hIndex: 0, totalCitations: 0, maxCitations: 0 };
        }
      } catch (err) {
        console.error("Admin expert ORCID fetch:", err.message);
        profileData.publications = profileData.publications || [];
        profileData.works = profileData.works || [];
        profileData.impactMetrics = profileData.impactMetrics || { totalPublications: 0, hIndex: 0, totalCitations: 0, maxCitations: 0 };
      }
    }

    // ResearchGate / Academia.edu: fetch metadata for admin view
    const [researchGateMetadata, academiaEduMetadata] = await Promise.all([
      researcher.researchGate ? fetchPageMetadata(researcher.researchGate) : Promise.resolve({ name: null, description: null }),
      researcher.academiaEdu ? fetchPageMetadata(researcher.academiaEdu) : Promise.resolve({ name: null, description: null }),
    ]);
    profileData.researchGateMetadata = researchGateMetadata.name || researchGateMetadata.description ? researchGateMetadata : null;
    profileData.academiaEduMetadata = academiaEduMetadata.name || academiaEduMetadata.description ? academiaEduMetadata : null;

    res.json({ profile: profileData });
  } catch (error) {
    console.error("Error fetching admin expert profile:", error);
    res.status(500).json({ error: "Failed to fetch expert profile" });
  }
});

// Dashboard overview stats (new joiners, totals)
router.get("/admin/stats/overview", verifyAdmin, async (req, res) => {
  try {
    const now = new Date();
    const last24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const thisWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thisMonth = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [patientUserIds, researcherUserIds] = await Promise.all([
      Profile.find({ role: "patient" }).distinct("userId"),
      Profile.find({ role: "researcher" }).distinct("userId"),
    ]);

    const [
      patientsLast24,
      patientsThisWeek,
      patientsThisMonth,
      researchersLast24,
      researchersThisWeek,
      researchersThisMonth,
      totalForums,
      totalDiscoveryPosts,
    ] = await Promise.all([
      patientUserIds.length
        ? User.countDocuments({
            _id: { $in: patientUserIds },
            createdAt: { $gte: last24 },
          })
        : 0,
      patientUserIds.length
        ? User.countDocuments({
            _id: { $in: patientUserIds },
            createdAt: { $gte: thisWeek },
          })
        : 0,
      patientUserIds.length
        ? User.countDocuments({
            _id: { $in: patientUserIds },
            createdAt: { $gte: thisMonth },
          })
        : 0,
      researcherUserIds.length
        ? User.countDocuments({
            _id: { $in: researcherUserIds },
            createdAt: { $gte: last24 },
          })
        : 0,
      researcherUserIds.length
        ? User.countDocuments({
            _id: { $in: researcherUserIds },
            createdAt: { $gte: thisWeek },
          })
        : 0,
      researcherUserIds.length
        ? User.countDocuments({
            _id: { $in: researcherUserIds },
            createdAt: { $gte: thisMonth },
          })
        : 0,
      ForumCategory.countDocuments(),
      Post.countDocuments(),
    ]);

    res.json({
      newPatients: { last24: patientsLast24, thisWeek: patientsThisWeek, thisMonth: patientsThisMonth },
      newResearchers: { last24: researchersLast24, thisWeek: researchersThisWeek, thisMonth: researchersThisMonth },
      totalForums: totalForums,
      totalDiscoveryPosts: totalDiscoveryPosts,
    });
  } catch (error) {
    console.error("Error fetching overview stats:", error);
    res.status(500).json({ error: "Failed to fetch overview stats" });
  }
});

// Get all patients with optional sort
router.get("/admin/patients", verifyAdmin, async (req, res) => {
  try {
    const { sortBy = "accountCreated", order = "desc" } = req.query;

    const profiles = await Profile.find({ role: "patient" })
      .populate("userId", "username email createdAt")
      .lean();

    const patientList = profiles.filter((p) => p.userId);
    const userIds = patientList.map((p) => p.userId._id || p.userId.id);
    const activity = userIds.length ? await getActivityCounts(userIds) : { threads: {}, replies: {}, posts: {}, comments: {}, communities: {} };

    let patients = patientList.map((profile) => {
      const user = profile.userId;
      const patient = profile.patient || {};
      const uid = (user._id || user.id).toString();
      return {
        _id: user._id || user.id,
        userId: user._id || user.id,
        name: user.username || "Unknown Patient",
        email: user.email,
        accountCreated: user.createdAt || null,
        conditions: patient.conditions || [],
        location: patient.location || null,
        threadCount: activity.threads[uid] || 0,
        replyCount: activity.replies[uid] || 0,
        postCount: activity.posts[uid] || 0,
        commentCount: activity.comments[uid] || 0,
        communityCount: activity.communities[uid] || 0,
      };
    });

    const dir = order === "asc" ? 1 : -1;
    if (sortBy === "name") {
      patients.sort((a, b) => dir * (a.name || "").localeCompare(b.name || ""));
    } else if (sortBy === "accountCreated") {
      patients.sort((a, b) => {
        const da = a.accountCreated ? new Date(a.accountCreated).getTime() : 0;
        const db = b.accountCreated ? new Date(b.accountCreated).getTime() : 0;
        return dir * (da - db);
      });
    } else if (sortBy === "activity") {
      patients.sort((a, b) => {
        const totalA = (a.threadCount || 0) + (a.replyCount || 0) + (a.postCount || 0) + (a.commentCount || 0);
        const totalB = (b.threadCount || 0) + (b.replyCount || 0) + (b.postCount || 0) + (b.commentCount || 0);
        return dir * (totalA - totalB);
      });
    }

    res.json({ patients });
  } catch (error) {
    console.error("Error fetching patients for admin:", error);
    res.status(500).json({ error: "Failed to fetch patients" });
  }
});

// Delete patient account completely (admin only)
router.delete("/admin/patients/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid patient ID" });
    }

    const profile = await Profile.findOne({ userId: id, role: "patient" });
    if (!profile) {
      return res.status(404).json({ error: "Patient not found" });
    }

    const userId = new mongoose.Types.ObjectId(id);

    const threadIds = await Thread.find({ authorUserId: userId }).distinct("_id");
    await Reply.deleteMany({ $or: [{ authorUserId: userId }, { threadId: { $in: threadIds } }] });
    await Thread.deleteMany({ authorUserId: userId });

    const postIds = await Post.find({ authorUserId: userId }).distinct("_id");
    await Comment.deleteMany({ $or: [{ authorUserId: userId }, { postId: { $in: postIds } }] });
    await Post.deleteMany({ authorUserId: userId });

    await CommunityMembership.deleteMany({ userId });
    await Profile.deleteOne({ userId });
    await User.findByIdAndDelete(id);

    res.json({ ok: true, message: "Patient account deleted completely" });
  } catch (error) {
    console.error("Error deleting patient:", error);
    res.status(500).json({ error: "Failed to delete patient" });
  }
});

// ============================================
// SEARCH LIMIT MANAGEMENT ENDPOINTS (FOR TESTING)
// ============================================

// Reset all search limits (token-based)
router.post("/admin/search/reset-all", verifyAdmin, async (req, res) => {
  try {
    const result = await SearchLimit.updateMany(
      {},
      { $set: { searchCount: 0, lastSearchAt: null } }
    );

    res.json({
      success: true,
      message: "Reset all search limits successfully",
      recordsReset: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error resetting search limits:", error);
    res.status(500).json({ error: "Failed to reset search limits" });
  }
});

// Get current search limit configuration
router.get("/admin/search/config", verifyAdmin, async (req, res) => {
  try {
    const MAX_FREE_SEARCHES = parseInt(
      process.env.MAX_FREE_SEARCHES || "6",
      10
    );

    // Get statistics
    const [tokenCount, totalSearches] = await Promise.all([
      SearchLimit.countDocuments({}),
      SearchLimit.aggregate([
        { $group: { _id: null, total: { $sum: "$searchCount" } } },
      ]),
    ]);

    res.json({
      maxFreeSearches: MAX_FREE_SEARCHES,
      statistics: {
        anonymousTokens: {
          total: tokenCount,
          totalSearches: totalSearches[0]?.total || 0,
        },
      },
    });
  } catch (error) {
    console.error("Error getting search config:", error);
    res.status(500).json({ error: "Failed to get search configuration" });
  }
});

// Reset verification email limit for a user (admin only)
router.post("/admin/users/:userId/reset-verification-email-limit", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Reset the lastVerificationEmailSent timestamp
    user.lastVerificationEmailSent = undefined;
    await user.save();

    return res.json({
      success: true,
      message: `Verification email limit reset for user ${user.email || userId}`,
      user: {
        userId: user._id.toString(),
        email: user.email,
        username: user.username,
      },
    });
  } catch (error) {
    console.error("Error resetting verification email limit:", error);
    res.status(500).json({ error: "Failed to reset verification email limit" });
  }
});

// ============================================
// FORUMS MANAGEMENT (admin)
// ============================================

// List forum categories
router.get("/admin/forums/categories", verifyAdmin, async (req, res) => {
  try {
    const categories = await ForumCategory.find({}).sort({ name: 1 }).lean();
    const categoryIds = categories.map((c) => c._id);
    const threadCounts = await Thread.aggregate([
      { $match: { categoryId: { $in: categoryIds } } },
      { $group: { _id: "$categoryId", count: { $sum: 1 } } },
    ]);
    const countMap = {};
    threadCounts.forEach((item) => {
      countMap[item._id.toString()] = item.count;
    });
    const withCounts = categories.map((cat) => ({
      ...cat,
      threadCount: countMap[cat._id.toString()] || 0,
    }));
    res.json({ categories: withCounts });
  } catch (error) {
    console.error("Error fetching forum categories:", error);
    res.status(500).json({ error: "Failed to fetch forum categories" });
  }
});

// Delete forum category (and its threads + replies)
router.delete("/admin/forums/categories/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const category = await ForumCategory.findById(id);
    if (!category) {
      return res.status(404).json({ error: "Forum category not found" });
    }
    const threadIds = await Thread.find({ categoryId: id }).distinct("_id");
    await Reply.deleteMany({ threadId: { $in: threadIds } });
    await Thread.deleteMany({ categoryId: id });
    await ForumCategory.findByIdAndDelete(id);
    res.json({ ok: true, message: "Forum category deleted successfully" });
  } catch (error) {
    console.error("Error deleting forum category:", error);
    res.status(500).json({ error: "Failed to delete forum category" });
  }
});

// List forum threads (all or by category)
router.get("/admin/forums/threads", verifyAdmin, async (req, res) => {
  try {
    const { categoryId, page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const query = categoryId ? { categoryId } : {};
    const threads = await Thread.find(query)
      .populate("categoryId", "name slug")
      .populate("authorUserId", "username email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    const total = await Thread.countDocuments(query);
    const threadIds = threads.map((t) => t._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyMap = {};
    replyCounts.forEach((item) => {
      replyMap[item._id.toString()] = item.count;
    });
    const withCounts = threads.map((t) => ({
      ...t,
      replyCount: replyMap[t._id.toString()] || 0,
    }));
    res.json({
      threads: withCounts,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error("Error fetching forum threads:", error);
    res.status(500).json({ error: "Failed to fetch forum threads" });
  }
});

// Delete forum thread (and its replies)
router.delete("/admin/forums/threads/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const thread = await Thread.findById(id);
    if (!thread) {
      return res.status(404).json({ error: "Thread not found" });
    }
    await Reply.deleteMany({ threadId: id });
    await Thread.findByIdAndDelete(id);
    res.json({ ok: true, message: "Thread deleted successfully" });
  } catch (error) {
    console.error("Error deleting thread:", error);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

// ============================================
// POSTS MANAGEMENT (admin)
// ============================================

// List all posts (paginated)
router.get("/admin/posts", verifyAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, communityId } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const query = communityId ? { communityId } : {};
    const posts = await Post.find(query)
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    const total = await Post.countDocuments(query);
    res.json({
      posts,
      pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// Delete any post (admin)
router.delete("/admin/posts/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }
    await Comment.deleteMany({ postId: id });
    await Post.findByIdAndDelete(id);
    res.json({ ok: true, message: "Post deleted successfully" });
  } catch (error) {
    console.error("Error deleting post:", error);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// ============================================
// ADMIN UPLOAD (for community thumbnails, etc.)
// ============================================
router.post("/admin/upload", verifyAdmin, uploadSingle, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }
    if (!req.file.mimetype.startsWith("image/")) {
      return res.status(400).json({ error: "File must be an image" });
    }
    const result = await uploadImage(
      req.file.buffer,
      "communities/thumbnails",
      req.file.originalname,
      req.file.mimetype
    );
    res.json({ ok: true, url: result.url || result.secure_url });
  } catch (error) {
    console.error("Error in admin upload:", error);
    res.status(500).json({ error: "Failed to upload file" });
  }
});

// ============================================
// COMMUNITY MANAGEMENT (admin)
// ============================================

// List communities (optional ?type=patient|researcher)
router.get("/admin/communities", verifyAdmin, async (req, res) => {
  try {
    const { type } = req.query;
    const query = type === "researcher" ? { communityType: "researcher" } : type === "patient" ? { $or: [{ communityType: "patient" }, { communityType: { $exists: false } }] } : {};
    const communities = await Community.find(query).sort({ name: 1 }).lean();
    const communityIds = communities.map((c) => c._id);
    const [memberCounts, threadCounts] = await Promise.all([
      CommunityMembership.aggregate([
        { $match: { communityId: { $in: communityIds } } },
        { $group: { _id: "$communityId", count: { $sum: 1 } } },
      ]),
      Thread.aggregate([
        { $match: { communityId: { $in: communityIds } } },
        { $group: { _id: "$communityId", count: { $sum: 1 } } },
      ]),
    ]);
    const memberMap = {};
    const threadMap = {};
    memberCounts.forEach((item) => { memberMap[item._id.toString()] = item.count; });
    threadCounts.forEach((item) => { threadMap[item._id.toString()] = item.count; });
    const withCounts = communities.map((c) => ({
      ...c,
      memberCount: memberMap[c._id.toString()] || 0,
      threadCount: threadMap[c._id.toString()] || 0,
    }));
    res.json({ communities: withCounts });
  } catch (error) {
    console.error("Error fetching communities:", error);
    res.status(500).json({ error: "Failed to fetch communities" });
  }
});

// Create community (admin) — supports communityType: "patient" | "researcher"
router.post("/admin/communities", verifyAdmin, async (req, res) => {
  try {
    const { name, description, coverImage, thumbnailUrl, tags, isOfficial, communityType } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }
    const type = communityType === "researcher" ? "researcher" : "patient";
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    // Differentiate Patient vs Researcher: same name can exist in both
    if (type === "researcher") {
      slug = slug ? `${slug}-researcher` : "researcher";
    }
    const existing = await Community.findOne({ slug });
    if (existing) {
      return res.status(400).json({ error: "A community with this name already exists" });
    }
    const community = await Community.create({
      name: name.trim(),
      slug,
      description: description || "",
      coverImage: coverImage || thumbnailUrl || "",
      tags: Array.isArray(tags) ? tags : [],
      isOfficial: !!isOfficial,
      communityType: type,
      createdByResearcher: false, // Admin-created, not researcher-proposed
    });
    res.status(201).json({ ok: true, community });
  } catch (error) {
    console.error("Error creating community:", error);
    res.status(500).json({ error: "Failed to create community" });
  }
});

// Delete community (admin) – cascades memberships, subcategories; threads/replies may remain with orphaned refs or you can delete them
router.delete("/admin/communities/:id", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const community = await Community.findById(id);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }
    const threadIds = await Thread.find({ communityId: id }).distinct("_id");
    await Reply.deleteMany({ threadId: { $in: threadIds } });
    await Thread.deleteMany({ communityId: id });
    await CommunityMembership.deleteMany({ communityId: id });
    await Subcategory.deleteMany({ parentCommunityId: id });
    await Post.updateMany({ communityId: id }, { $set: { communityId: null } });
    await Community.findByIdAndDelete(id);
    res.json({ ok: true, message: "Community deleted successfully" });
  } catch (error) {
    console.error("Error deleting community:", error);
    res.status(500).json({ error: "Failed to delete community" });
  }
});

// ============================================
// COMMUNITY PROPOSALS (admin)
// ============================================

// List community proposals (pending first, then all)
router.get("/admin/community-proposals", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    const proposals = await CommunityProposal.find(query)
      .populate("proposedBy", "username email")
      .sort({ status: 1, createdAt: -1 })
      .lean();
    res.json({ proposals });
  } catch (error) {
    console.error("Error fetching community proposals:", error);
    res.status(500).json({ error: "Failed to fetch proposals" });
  }
});

// Approve a community proposal — creates the community and adds proposer as admin member
router.post("/admin/community-proposals/:id/approve", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { thumbnailUrl } = req.body;

    const proposal = await CommunityProposal.findById(id);
    if (!proposal) {
      return res.status(404).json({ error: "Proposal not found" });
    }
    if (proposal.status !== "pending") {
      return res.status(400).json({ error: "Proposal already reviewed" });
    }

    const name = proposal.title.trim();
    const isResearcherProposal = proposal.proposedByRole === "researcher";
    let slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
    // Differentiate Patient vs Researcher: same name can exist in both
    if (isResearcherProposal) {
      slug = slug ? `${slug}-researcher` : "researcher";
    }

    const existing = await Community.findOne({ slug });
    if (existing) {
      return res.status(400).json({
        error: "A community with this name already exists. Reject the proposal or use a different name.",
      });
    }

    const community = await Community.create({
      name,
      slug,
      description: proposal.description || "",
      coverImage: thumbnailUrl || proposal.thumbnailUrl || "",
      createdBy: proposal.proposedBy,
      isOfficial: false,
      communityType: isResearcherProposal ? "researcher" : "patient",
      createdByResearcher: isResearcherProposal,
    });

    await CommunityMembership.create({
      userId: proposal.proposedBy,
      communityId: community._id,
      role: "admin",
    });

    proposal.status = "approved";
    proposal.reviewedAt = new Date();
    proposal.reviewedBy = req.adminUserId;
    proposal.createdCommunityId = community._id;
    await proposal.save();

    res.json({
      ok: true,
      message: "Community created and proposal approved",
      community,
    });
  } catch (error) {
    console.error("Error approving community proposal:", error);
    res.status(500).json({ error: "Failed to approve proposal" });
  }
});

// Reject a community proposal
router.post("/admin/community-proposals/:id/reject", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const proposal = await CommunityProposal.findById(id);
    if (!proposal) {
      return res.status(404).json({ error: "Proposal not found" });
    }
    if (proposal.status !== "pending") {
      return res.status(400).json({ error: "Proposal already reviewed" });
    }

    proposal.status = "rejected";
    proposal.reviewedAt = new Date();
    proposal.reviewedBy = req.adminUserId;
    await proposal.save();

    res.json({ ok: true, message: "Proposal rejected" });
  } catch (error) {
    console.error("Error rejecting community proposal:", error);
    res.status(500).json({ error: "Failed to reject proposal" });
  }
});

// ============================================
// WORK SUBMISSIONS (admin moderation)
// ============================================

router.get("/admin/work-submissions", verifyAdmin, async (req, res) => {
  try {
    const { status } = req.query;
    const query = status ? { status } : {};
    const submissions = await WorkSubmission.find(query)
      .populate("submittedBy", "username email")
      .sort({ status: 1, createdAt: -1 })
      .lean();
    res.json({ submissions });
  } catch (error) {
    console.error("Error fetching work submissions:", error);
    res.status(500).json({ error: "Failed to fetch work submissions" });
  }
});

router.post("/admin/work-submissions/:id/approve", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    const submission = await WorkSubmission.findById(id);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }
    if (submission.status !== "pending") {
      return res.status(400).json({ error: "Submission already reviewed" });
    }

    if (submission.type === "publication") {
      const profile = await Profile.findOne({ userId: submission.submittedBy });
      if (!profile || profile.role !== "researcher") {
        return res.status(404).json({ error: "Researcher profile not found" });
      }

      const publicationEntry = {
        title: submission.title || "Untitled",
        year: Number.isFinite(submission.year) ? submission.year : undefined,
        journal: submission.journal || undefined,
        journalTitle: submission.journal || undefined,
        doi: submission.doi || undefined,
        pmid: submission.pmid || undefined,
        link: submission.link || undefined,
        url: submission.link || undefined,
        authors: Array.isArray(submission.authors) ? submission.authors : [],
        source: submission.source || "manual",
      };

      if (!profile.researcher) profile.researcher = {};
      if (!Array.isArray(profile.researcher.selectedPublications)) {
        profile.researcher.selectedPublications = [];
      }
      profile.researcher.selectedPublications.push(publicationEntry);
      await profile.save();
    } else {
      await Trial.create({
        ownerResearcherId: submission.submittedBy,
        title: submission.title || "Untitled Trial",
        status: submission.trialStatus || "",
        phase: submission.phase || "",
        location: submission.location || "",
        eligibility: submission.eligibility || "",
        description: submission.description || "",
        contacts: Array.isArray(submission.contacts) ? submission.contacts : [],
      });
    }

    submission.status = "approved";
    submission.reviewedAt = new Date();
    submission.reviewedBy = req.adminUserId;
    await submission.save();

    res.json({ ok: true, message: "Work submission approved" });
  } catch (error) {
    console.error("Error approving work submission:", error);
    res.status(500).json({ error: "Failed to approve work submission" });
  }
});

router.post("/admin/work-submissions/:id/reject", verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { adminNote } = req.body || {};

    const submission = await WorkSubmission.findById(id);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }
    if (submission.status !== "pending") {
      return res.status(400).json({ error: "Submission already reviewed" });
    }

    submission.status = "rejected";
    submission.adminNote = adminNote ? String(adminNote).trim() : undefined;
    submission.reviewedAt = new Date();
    submission.reviewedBy = req.adminUserId;
    await submission.save();

    res.json({ ok: true, message: "Work submission rejected" });
  } catch (error) {
    console.error("Error rejecting work submission:", error);
    res.status(500).json({ error: "Failed to reject work submission" });
  }
});

export default router;
