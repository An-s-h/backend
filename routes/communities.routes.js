import { Router } from "express";
import mongoose from "mongoose";
import { Community } from "../models/Community.js";
import { CommunityProposal } from "../models/CommunityProposal.js";
import { Subcategory } from "../models/Subcategory.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Notification } from "../models/Notification.js";
import { verifySession } from "../middleware/auth.js";

const router = Router();

// Cache implementation
const cache = new Map();
const CACHE_TTL = {
  communities: 1000 * 60 * 5, // 5 minutes
  threads: 1000 * 60 * 2, // 2 minutes
  memberCounts: 1000 * 60 * 3, // 3 minutes
};

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value, ttl) {
  cache.set(key, { value, expires: Date.now() + ttl });
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) {
        cache.delete(k);
      }
    }
  }
}

function invalidateCache(pattern) {
  for (const key of cache.keys()) {
    if (key.includes(pattern)) {
      cache.delete(key);
    }
  }
}

// Normalize condition tags from query/body
function normalizeConditions(input) {
  if (!input) return [];
  const list = Array.isArray(input)
    ? input
    : String(input)
        .split(",")
        .map((item) => item.trim());
  return list
    .map((item) => item?.trim())
    .filter(Boolean)
    .slice(0, 10);
}

// ============================================
// COMMUNITY ROUTES
// ============================================

// Get all communities with member counts and thread counts
router.get("/communities", async (req, res) => {
  try {
    const { userId, search, type } = req.query;
    const cacheKey = `communities:all:${search || ""}:${type || ""}`;
    
    let cached = getCache(cacheKey);
    if (cached && !userId) {
      return res.json({ communities: cached });
    }

    let query = {};
    if (type === "patient") {
      query.$or = [{ communityType: "patient" }, { communityType: { $exists: false } }];
    } else if (type === "researcher") {
      query.communityType = "researcher";
    }
    if (search) {
      const searchClause = {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { tags: { $elemMatch: { $regex: search, $options: "i" } } },
        ],
      };
      query = Object.keys(query).length > 0 ? { $and: [query, searchClause] } : searchClause;
    }

    const communities = await Community.find(query).sort({ name: 1 }).lean();
    const communityIds = communities.map((c) => c._id);

    // Get member counts
    const memberCounts = await CommunityMembership.aggregate([
      { $match: { communityId: { $in: communityIds } } },
      { $group: { _id: "$communityId", count: { $sum: 1 } } },
    ]);
    const memberCountMap = {};
    memberCounts.forEach((item) => {
      memberCountMap[item._id.toString()] = item.count;
    });

    // Get thread counts
    const threadCounts = await Thread.aggregate([
      { $match: { communityId: { $in: communityIds } } },
      { $group: { _id: "$communityId", count: { $sum: 1 } } },
    ]);
    const threadCountMap = {};
    threadCounts.forEach((item) => {
      threadCountMap[item._id.toString()] = item.count;
    });

    // Get user's memberships if userId provided
    let userMemberships = [];
    if (userId) {
      userMemberships = await CommunityMembership.find({ userId }).lean();
    }
    const userMembershipMap = {};
    userMemberships.forEach((m) => {
      userMembershipMap[m.communityId.toString()] = m;
    });

    const communitiesWithData = communities.map((community) => ({
      ...community,
      image: community.coverImage || community.image,
      memberCount: memberCountMap[community._id.toString()] || 0,
      threadCount: threadCountMap[community._id.toString()] || 0,
      isFollowing: !!userMembershipMap[community._id.toString()],
      membership: userMembershipMap[community._id.toString()] || null,
    }));

    if (!userId) {
      setCache(cacheKey, communitiesWithData, CACHE_TTL.communities);
    }

    res.json({ communities: communitiesWithData });
  } catch (error) {
    console.error("Error fetching communities:", error);
    res.status(500).json({ error: "Failed to fetch communities" });
  }
});

// Propose a new community (patients and researchers) — requires auth
router.post("/communities/proposals", verifySession, async (req, res) => {
  try {
    const { title, description, thumbnailUrl } = req.body;
    const proposedBy = req.user._id;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "Title is required" });
    }

    const profile = await Profile.findOne({ userId: proposedBy }).lean();
    const proposedByRole = profile?.role === "researcher" ? "researcher" : "patient";

    const proposal = await CommunityProposal.create({
      title: String(title).trim(),
      description: description ? String(description).trim() : "",
      thumbnailUrl: thumbnailUrl || "",
      proposedBy,
      proposedByRole,
      status: "pending",
    });

    const populated = await CommunityProposal.findById(proposal._id)
      .populate("proposedBy", "username email")
      .lean();

    res.status(201).json({ ok: true, proposal: populated });
  } catch (error) {
    console.error("Error creating community proposal:", error);
    res.status(500).json({ error: "Failed to submit proposal" });
  }
});

// Get a single community by ID or slug
router.get("/communities/:idOrSlug", async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const { userId } = req.query;

    let community;
    if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
      community = await Community.findById(idOrSlug).lean();
    } else {
      community = await Community.findOne({ slug: idOrSlug }).lean();
    }

    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    // Get member count
    const memberCount = await CommunityMembership.countDocuments({ communityId: community._id });

    // Get thread count
    const threadCount = await Thread.countDocuments({ communityId: community._id });

    // Check if user is following
    let isFollowing = false;
    let membership = null;
    if (userId) {
      membership = await CommunityMembership.findOne({
        userId,
        communityId: community._id,
      }).lean();
      isFollowing = !!membership;
    }

    res.json({
      community: {
        ...community,
        memberCount,
        threadCount,
        isFollowing,
        membership,
      },
    });
  } catch (error) {
    console.error("Error fetching community:", error);
    res.status(500).json({ error: "Failed to fetch community" });
  }
});

// Follow/Join a community
router.post("/communities/:communityId/follow", async (req, res) => {
  try {
    const { communityId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    // Check if already following
    const existing = await CommunityMembership.findOne({ userId, communityId });
    if (existing) {
      return res.status(400).json({ error: "Already following this community" });
    }

    await CommunityMembership.create({
      userId,
      communityId,
      role: "member",
    });

    invalidateCache("communities");

    res.json({ ok: true, message: "Successfully joined community" });
  } catch (error) {
    console.error("Error following community:", error);
    res.status(500).json({ error: "Failed to follow community" });
  }
});

// Unfollow/Leave a community
router.delete("/communities/:communityId/follow", async (req, res) => {
  try {
    const { communityId } = req.params;
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    await CommunityMembership.deleteOne({ userId, communityId });

    invalidateCache("communities");

    res.json({ ok: true, message: "Successfully left community" });
  } catch (error) {
    console.error("Error unfollowing community:", error);
    res.status(500).json({ error: "Failed to unfollow community" });
  }
});

// Get user's followed communities
router.get("/communities/user/:userId/following", async (req, res) => {
  try {
    const { userId } = req.params;

    const memberships = await CommunityMembership.find({ userId })
      .populate("communityId")
      .lean();

    const communityIds = memberships.map((m) => m.communityId._id);

    // Get thread counts for each community
    const threadCounts = await Thread.aggregate([
      { $match: { communityId: { $in: communityIds } } },
      { $group: { _id: "$communityId", count: { $sum: 1 } } },
    ]);
    const threadCountMap = {};
    threadCounts.forEach((item) => {
      threadCountMap[item._id.toString()] = item.count;
    });

    // Get member counts
    const memberCounts = await CommunityMembership.aggregate([
      { $match: { communityId: { $in: communityIds } } },
      { $group: { _id: "$communityId", count: { $sum: 1 } } },
    ]);
    const memberCountMap = {};
    memberCounts.forEach((item) => {
      memberCountMap[item._id.toString()] = item.count;
    });

    const communities = memberships.map((m) => ({
      ...m.communityId,
      memberCount: memberCountMap[m.communityId._id.toString()] || 0,
      threadCount: threadCountMap[m.communityId._id.toString()] || 0,
      isFollowing: true,
      membership: {
        role: m.role,
        notifications: m.notifications,
        joinedAt: m.createdAt,
      },
    }));

    res.json({ communities });
  } catch (error) {
    console.error("Error fetching followed communities:", error);
    res.status(500).json({ error: "Failed to fetch followed communities" });
  }
});

// ============================================
// THREAD ROUTES FOR COMMUNITIES
// ============================================

// Get threads for a community
router.get("/communities/:communityId/threads", async (req, res) => {
  try {
    const { communityId } = req.params;
    const {
      sort = "recent",
      page = 1,
      limit = 20,
      subcategoryId,
      condition,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let sortOption = { createdAt: -1 };
    if (sort === "popular") {
      sortOption = { viewCount: -1 };
    } else if (sort === "top") {
      // Will sort by vote score after aggregation
    }

    const normalizedConditions = normalizeConditions(condition);

    const { excludeResearcherForum } = req.query;
    let query = {
      communityId,
      ...(normalizedConditions.length > 0
        ? { conditions: { $in: normalizedConditions } }
        : {}),
      // Exclude researcher forum posts if requested (for Health Forums)
      ...(excludeResearcherForum === "true"
        ? { isResearcherForum: { $ne: true } }
        : {}),
    };
    if (subcategoryId) {
      query.subcategoryId = subcategoryId;
    }

    const threads = await Thread.find(query)
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .populate("subcategoryId", "name slug")
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get reply counts and researcher-reply flags
    const threadIds = threads.map((t) => t._id);
    const [replyCounts, researcherReplies] = await Promise.all([
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]),
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
        { $group: { _id: "$threadId" } },
      ]),
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });
    const researcherReplyThreadIds = new Set(
      researcherReplies.map((r) => r._id.toString())
    );

    const threadsWithData = threads.map((thread) => ({
      ...thread,
      replyCount: replyCountMap[thread._id.toString()] || 0,
      voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
      hasResearcherReply:
        researcherReplyThreadIds.has(thread._id.toString()) ||
        thread.authorRole === "researcher",
    }));

    // Sort by vote score if top
    if (sort === "top") {
      threadsWithData.sort((a, b) => b.voteScore - a.voteScore);
    }

    const total = await Thread.countDocuments(query);

    res.json({
      threads: threadsWithData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching community threads:", error);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

// Get threads from followed communities (feed)
router.get("/communities/feed/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { page = 1, limit = 20 } = req.query;

    const memberships = await CommunityMembership.find({ userId }).lean();
    const communityIds = memberships.map((m) => m.communityId);

    if (communityIds.length === 0) {
      return res.json({ threads: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Health Forums (patient) feed: exclude researcher-only posts
    const feedQuery = {
      communityId: { $in: communityIds },
      isResearcherForum: { $ne: true },
    };
    const threads = await Thread.find(feedQuery)
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get reply counts and researcher-reply flags
    const threadIds = threads.map((t) => t._id);
    const [replyCounts, researcherReplies] = await Promise.all([
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]),
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
        { $group: { _id: "$threadId" } },
      ]),
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });
    const researcherReplyThreadIds = new Set(
      researcherReplies.map((r) => r._id.toString())
    );

    const threadsWithData = threads.map((thread) => ({
      ...thread,
      replyCount: replyCountMap[thread._id.toString()] || 0,
      voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
      hasResearcherReply:
        researcherReplyThreadIds.has(thread._id.toString()) ||
        thread.authorRole === "researcher",
    }));

    const total = await Thread.countDocuments(feedQuery);

    res.json({
      threads: threadsWithData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error fetching feed:", error);
    res.status(500).json({ error: "Failed to fetch feed" });
  }
});

// Get recommended threads based on user interests
router.get("/communities/recommended/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;

    // Get user profile to find interests
    const profile = await Profile.findOne({ userId }).lean();
    if (!profile) {
      return res.json({ threads: [] });
    }

    // Extract user interests/conditions
    let interests = [];
    if (profile.role === "patient" && profile.patient?.conditions) {
      interests = profile.patient.conditions;
    } else if (profile.role === "researcher") {
      interests = [
        ...(profile.researcher?.specialties || []),
        ...(profile.researcher?.interests || []),
      ];
    }

    if (interests.length === 0) {
      // Return popular threads if no interests (exclude researcher-only for Health Forums)
      const threads = await Thread.find({ isResearcherForum: { $ne: true } })
        .populate("authorUserId", "username email")
        .populate("communityId", "name slug icon color")
        .sort({ viewCount: -1 })
        .limit(parseInt(limit))
        .lean();

      const threadIds = threads.map((t) => t._id);
      const [replyCounts, researcherReplies] = await Promise.all([
        Reply.aggregate([
          { $match: { threadId: { $in: threadIds } } },
          { $group: { _id: "$threadId", count: { $sum: 1 } } },
        ]),
        Reply.aggregate([
          { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
          { $group: { _id: "$threadId" } },
        ]),
      ]);
      const replyCountMap = {};
      replyCounts.forEach((item) => {
        replyCountMap[item._id.toString()] = item.count;
      });
      const researcherReplyThreadIds = new Set(
        researcherReplies.map((r) => r._id.toString())
      );

      return res.json({
        threads: threads.map((t) => ({
          ...t,
          replyCount: replyCountMap[t._id.toString()] || 0,
          voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
          hasResearcherReply:
            researcherReplyThreadIds.has(t._id.toString()) || t.authorRole === "researcher",
        })),
      });
    }

    // Find communities matching user interests
    const matchingCommunities = await Community.find({
      tags: { $in: interests.map((i) => new RegExp(i, "i")) },
    }).lean();

    const communityIds = matchingCommunities.map((c) => c._id);

    // Get threads from matching communities or with matching keywords (exclude researcher-only)
    const threads = await Thread.find({
      isResearcherForum: { $ne: true },
      $or: [
        { communityId: { $in: communityIds } },
        { title: { $regex: interests.join("|"), $options: "i" } },
        { body: { $regex: interests.join("|"), $options: "i" } },
      ],
    })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .lean();

    const threadIds = threads.map((t) => t._id);
    const [replyCounts, researcherReplies] = await Promise.all([
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]),
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
        { $group: { _id: "$threadId" } },
      ]),
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });
    const researcherReplyThreadIds = new Set(
      researcherReplies.map((r) => r._id.toString())
    );

    res.json({
      threads: threads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
        hasResearcherReply:
          researcherReplyThreadIds.has(t._id.toString()) || t.authorRole === "researcher",
      })),
    });
  } catch (error) {
    console.error("Error fetching recommended threads:", error);
    res.status(500).json({ error: "Failed to fetch recommended threads" });
  }
});

// Get threads involving a user (threads they created or replied to)
router.get("/communities/involving/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20 } = req.query;

    // Get threads created by user (Health Forums: exclude researcher-only posts)
    const userThreads = await Thread.find({
      authorUserId: userId,
      isResearcherForum: { $ne: true },
    })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .lean();

    // Get threads where user has replied
    const userReplies = await Reply.find({ authorUserId: userId }).distinct("threadId");
    const repliedThreads = await Thread.find({
      _id: { $in: userReplies },
      authorUserId: { $ne: userId },
      isResearcherForum: { $ne: true },
    })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .lean();

    // Combine and deduplicate
    const allThreads = [...userThreads, ...repliedThreads];
    allThreads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const limitedThreads = allThreads.slice(0, parseInt(limit));

    // Get reply counts and researcher-reply flags
    const threadIds = limitedThreads.map((t) => t._id);
    const [replyCounts, researcherReplies] = await Promise.all([
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]),
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
        { $group: { _id: "$threadId" } },
      ]),
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });
    const researcherReplyThreadIds = new Set(
      researcherReplies.map((r) => r._id.toString())
    );

    res.json({
      threads: limitedThreads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
        hasResearcherReply:
          researcherReplyThreadIds.has(t._id.toString()) || t.authorRole === "researcher",
        isOwnThread: t.authorUserId?._id?.toString() === userId || t.authorUserId?.toString() === userId,
      })),
    });
  } catch (error) {
    console.error("Error fetching involving threads:", error);
    res.status(500).json({ error: "Failed to fetch threads" });
  }
});

// Search threads across all communities
router.get("/communities/search/threads", async (req, res) => {
  try {
    const { q, communityId, page = 1, limit = 20 } = req.query;

    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: "Search query must be at least 2 characters" });
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let matchQuery = {
      $or: [
        { title: { $regex: q, $options: "i" } },
        { body: { $regex: q, $options: "i" } },
      ],
    };

    if (communityId) {
      matchQuery.communityId = new mongoose.Types.ObjectId(communityId);
    }

    const threads = await Thread.find(matchQuery)
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get reply counts and researcher-reply flags
    const threadIds = threads.map((t) => t._id);
    const [replyCounts, researcherReplies] = await Promise.all([
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]),
      Reply.aggregate([
        { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
        { $group: { _id: "$threadId" } },
      ]),
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });
    const researcherReplyThreadIds = new Set(
      researcherReplies.map((r) => r._id.toString())
    );

    const total = await Thread.countDocuments(matchQuery);

    res.json({
      threads: threads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
        hasResearcherReply:
          researcherReplyThreadIds.has(t._id.toString()) || t.authorRole === "researcher",
      })),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (error) {
    console.error("Error searching threads:", error);
    res.status(500).json({ error: "Failed to search threads" });
  }
});

// Create a new thread in a community
router.post("/communities/:communityId/threads", async (req, res) => {
  try {
    const { communityId } = req.params;
    const {
      authorUserId,
      authorRole,
      title,
      body,
      subcategoryId,
      tags,
      conditions,
      onlyResearchersCanReply,
      isResearcherForum,
    } = req.body;

    if (!authorUserId || !authorRole || !title || !body) {
      return res.status(400).json({
        error: "authorUserId, authorRole, title, body required",
      });
    }

    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    // Validate subcategory if provided
    if (subcategoryId) {
      const subcategory = await Subcategory.findOne({
        _id: subcategoryId,
        parentCommunityId: communityId,
      });
      if (!subcategory) {
        return res.status(404).json({
          error: "Subcategory not found or does not belong to this community",
        });
      }
    }

    const normalizedConditions = normalizeConditions(conditions);

    const thread = await Thread.create({
      communityId,
      categoryId: communityId, // For backward compatibility
      subcategoryId: subcategoryId || null,
      authorUserId,
      authorRole,
      title,
      body,
      tags: tags || [],
      conditions: normalizedConditions,
      onlyResearchersCanReply: !!onlyResearchersCanReply,
      isResearcherForum: !!isResearcherForum,
    });

    const populatedThread = await Thread.findById(thread._id)
      .populate("communityId", "name slug icon color")
      .populate("subcategoryId", "name slug")
      .populate("authorUserId", "username email")
      .lean();

    // Create notifications for community members if needed
    if (authorRole === "patient") {
      const authorProfile = await Profile.findOne({ userId: authorUserId }).lean();
      const patientConditions = authorProfile?.patient?.conditions || [];

      if (patientConditions.length > 0) {
        // Notify researchers in matching specialties who are members of this community
        const memberships = await CommunityMembership.find({
          communityId,
          notifications: true,
        }).lean();

        const memberUserIds = memberships.map((m) => m.userId);

        const researchers = await Profile.find({
          userId: { $in: memberUserIds },
          role: "researcher",
          $or: [
            { "researcher.specialties": { $in: patientConditions } },
            { "researcher.interests": { $in: patientConditions } },
          ],
        }).lean();

        const author = await User.findById(authorUserId).lean();

        for (const researcher of researchers) {
          if (researcher.userId.toString() !== authorUserId.toString()) {
            await Notification.create({
              userId: researcher.userId,
              type: "community_thread",
              relatedUserId: authorUserId,
              relatedItemId: thread._id,
              relatedItemType: "thread",
              title: "New Community Discussion",
              message: `${author?.username || "A patient"} posted in ${community.name}: "${title}"`,
              metadata: {
                threadId: thread._id.toString(),
                threadTitle: title,
                communityId: communityId,
                communityName: community.name,
              },
            });
          }
        }
      }
    }

    invalidateCache(`communities:${communityId}`);

    res.json({
      ok: true,
      thread: {
        ...populatedThread,
        replyCount: 0,
        voteScore: 0,
      },
    });
  } catch (error) {
    console.error("Error creating thread:", error);
    res.status(500).json({ error: "Failed to create thread" });
  }
});

// Create a new community (admin or researcher)
router.post("/communities", async (req, res) => {
  try {
    const { name, description, icon, color, tags, createdBy, isOfficial, communityType, createdByResearcher } = req.body;

    if (!name) {
      return res.status(400).json({ error: "name is required" });
    }

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    // Check if slug already exists
    const existing = await Community.findOne({ slug });
    if (existing) {
      return res.status(400).json({ error: "A community with this name already exists" });
    }

    const community = await Community.create({
      name,
      slug,
      description: description || "",
      icon: icon || "💬",
      color: color || "#2F3C96",
      tags: tags || [],
      createdBy,
      isOfficial: isOfficial || false,
      communityType: communityType || "patient",
      createdByResearcher: !!createdByResearcher,
    });

    // Auto-join creator
    if (createdBy) {
      await CommunityMembership.create({
        userId: createdBy,
        communityId: community._id,
        role: "admin",
      });
    }

    invalidateCache("communities");

    res.json({ ok: true, community });
  } catch (error) {
    console.error("Error creating community:", error);
    res.status(500).json({ error: "Failed to create community" });
  }
});

// Seed default subcategories for communities
router.post("/communities/:communityId/subcategories/seed", async (req, res) => {
  try {
    const { communityId } = req.params;

    // Prevent mongoose CastError on invalid ObjectId
    if (!mongoose.Types.ObjectId.isValid(communityId)) {
      return res.status(400).json({
        error: "Invalid communityId",
      });
    }

    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    // Define default Conditions & Topics for each community type
    const defaultSubcategories = {
      "autoimmune-conditions": [
        { name: "Rheumatoid Arthritis", tags: [] },
        { name: "Lupus (SLE)", tags: [] },
        { name: "Multiple Sclerosis (MS)", tags: [] },
        { name: "Psoriasis & Psoriatic Arthritis", tags: [] },
        { name: "Crohn's Disease", tags: [] },
        { name: "Ulcerative Colitis", tags: [] },
        { name: "Hashimoto's Thyroiditis", tags: [] },
        { name: "Graves' Disease", tags: [] },
        { name: "Sjögren's Syndrome", tags: [] },
        { name: "Type 1 Diabetes", tags: [] },
        { name: "Ankylosing Spondylitis", tags: [] },
        { name: "Vasculitis", tags: [] },
        { name: "Other immune-mediated inflammatory disorders", tags: [] },
      ],
      "chronic-pain": [
        { name: "Fibromyalgia", tags: [] },
        { name: "Chronic lower back pain", tags: [] },
        { name: "Neuropathic pain", tags: [] },
        { name: "Migraine & chronic headaches", tags: [] },
        { name: "Arthritis-related pain", tags: [] },
        { name: "Endometriosis-related pain", tags: [] },
        { name: "Chronic pelvic pain", tags: [] },
        { name: "Post-surgical or post-injury chronic pain", tags: [] },
        { name: "Pain associated with long-term conditions", tags: [] },
      ],
      "fitness-exercise": [
        { name: "Exercise for chronic conditions", tags: [] },
        { name: "Mobility limitations & low-impact fitness", tags: [] },
        { name: "Cardiac-safe exercise (educational)", tags: [] },
        { name: "Strength & endurance basics", tags: [] },
        { name: "Rehabilitation-adjacent movement (non-clinical)", tags: [] },
        { name: "Fatigue-aware exercise (e.g., chronic illness contexts)", tags: [] },
      ],
      "nutrition-diet": [
        { name: "General nutrition science", tags: [] },
        { name: "Diet patterns (Mediterranean, plant-based, etc.)", tags: [] },
        { name: "Nutrition for chronic conditions (educational)", tags: [] },
        { name: "Inflammation & diet research", tags: [] },
        { name: "Micronutrients & metabolism", tags: [] },
        { name: "Food labels, hydration, and gut health", tags: [] },
      ],
      "heart-health": [
        { name: "Hypertension (high blood pressure)", tags: [] },
        { name: "Coronary artery disease", tags: [] },
        { name: "Atherosclerosis", tags: [] },
        { name: "Arrhythmias (general understanding)", tags: [] },
        { name: "Heart failure (educational)", tags: [] },
        { name: "Stroke prevention (research-focused)", tags: [] },
        { name: "Cholesterol & lipid disorders", tags: [] },
      ],
      "heart-related": [
        { name: "Hypertension (high blood pressure)", tags: [] },
        { name: "Coronary artery disease", tags: [] },
        { name: "Atherosclerosis", tags: [] },
        { name: "Arrhythmias (general understanding)", tags: [] },
        { name: "Heart failure (educational)", tags: [] },
        { name: "Stroke prevention (research-focused)", tags: [] },
        { name: "Cholesterol & lipid disorders", tags: [] },
      ],
      "lung-cancer": [
        { name: "Lung cancer", tags: [] },
        { name: "Non-small cell lung cancer", tags: [] },
        { name: "Small cell lung cancer", tags: [] },
        { name: "Mesothelioma", tags: [] },
        { name: "Treatment options", tags: [] },
        { name: "Survivorship & support", tags: [] },
      ],
      "diabetes-management": [
        { name: "Type 1 Diabetes", tags: [] },
        { name: "Type 2 Diabetes", tags: [] },
        { name: "Prediabetes", tags: [] },
        { name: "Gestational diabetes (educational)", tags: [] },
        { name: "Insulin resistance & metabolic syndrome", tags: [] },
      ],
      "mental-health": [
        { name: "Anxiety disorders", tags: [] },
        { name: "Depression", tags: [] },
        { name: "Bipolar disorder (educational)", tags: [] },
        { name: "PTSD & trauma-related conditions", tags: [] },
        { name: "Stress & burnout", tags: [] },
        { name: "Sleep disorders", tags: [] },
        { name: "Emotional wellbeing in chronic illness", tags: [] },
      ],
      "cancer-support": [
        { name: "Breast cancer", tags: [] },
        { name: "Lung cancer", tags: [] },
        { name: "Colorectal cancer", tags: [] },
        { name: "Prostate cancer", tags: [] },
        { name: "Blood cancers", tags: [] },
        { name: "Brain tumors", tags: [] },
        { name: "Survivorship & post-treatment support", tags: [] },
        { name: "Caregiver perspectives", tags: [] },
      ],
      "general-health": [
        { name: "Preventive health", tags: [] },
        { name: "Vaccines (educational)", tags: [] },
        { name: "Public health topics", tags: [] },
        { name: "Health screenings", tags: [] },
        { name: "Common conditions (high-level)", tags: [] },
        { name: "Understanding lab tests & reports", tags: [] },
      ],
      "clinical-trials": [
        { name: "Oncology trials", tags: [] },
        { name: "Neurology trials", tags: [] },
        { name: "Autoimmune disease trials", tags: [] },
        { name: "Cardiovascular trials", tags: [] },
        { name: "Rare disease studies", tags: [] },
        { name: "Observational & registry studies", tags: [] },
      ],
      "cardiology": [
        { name: "Ischemic heart disease", tags: [] },
        { name: "Arrhythmias", tags: [] },
        { name: "Cardiomyopathies", tags: [] },
        { name: "Congenital heart disease (adult education)", tags: [] },
        { name: "Interventional cardiology research", tags: [] },
        { name: "Cardiac imaging & diagnostics", tags: [] },
      ],
      "oncology": [
        { name: "Solid tumors", tags: [] },
        { name: "Hematologic malignancies", tags: [] },
        { name: "Immuno-oncology", tags: [] },
        { name: "Radiation & surgical oncology (education)", tags: [] },
        { name: "Precision medicine", tags: [] },
        { name: "Oncology clinical trials", tags: [] },
      ],
      "neurology": [
        { name: "Parkinson's disease", tags: [] },
        { name: "Alzheimer's disease", tags: [] },
        { name: "Multiple sclerosis", tags: [] },
        { name: "Epilepsy", tags: [] },
        { name: "ALS", tags: [] },
        { name: "Migraine disorders", tags: [] },
        { name: "Stroke recovery (educational)", tags: [] },
      ],
      "cancer-research": [
        { name: "Molecular oncology", tags: [] },
        { name: "Biomarkers & genomics", tags: [] },
        { name: "Drug development", tags: [] },
        { name: "Translational research", tags: [] },
        { name: "Phase I–III trials", tags: [] },
        { name: "Real-world evidence studies", tags: [] },
      ],
      "basic-preclinical-research": [
        { name: "Molecular biology", tags: [] },
        { name: "Animal models", tags: [] },
        { name: "Gene editing (CRISPR)", tags: [] },
        { name: "Cell signaling", tags: [] },
      ],
      "translational-research": [
        { name: "Biomarker discovery", tags: [] },
        { name: "Drug screening", tags: [] },
        { name: "Lab findings to human relevance", tags: [] },
      ],
    };

    const communitySubcategories = defaultSubcategories[community.slug] || [];
    if (communitySubcategories.length === 0) {
      return res.json({
        ok: true,
        message: "No default Conditions & Topics defined for this community",
        subcategories: [],
      });
    }

    // Remove all existing subcategories for this community
    await Subcategory.deleteMany({ parentCommunityId: communityId });

    const created = [];
    for (const subcat of communitySubcategories) {
      const slug = subcat.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");

      const newSubcategory = await Subcategory.create({
        name: subcat.name,
        slug,
        description: "",
        parentCommunityId: communityId,
        tags: subcat.tags || [],
        isOfficial: true,
      });
      created.push(newSubcategory);
    }

    invalidateCache(`communities:${communityId}`);

    res.json({
      ok: true,
      message: `Created ${created.length} Conditions & Topics`,
      subcategories: created,
    });
  } catch (error) {
    console.error("Error seeding subcategories:", error);
    res.status(500).json({ error: "Failed to seed subcategories" });
  }
});

// Seed default communities (run once)
router.post("/communities/seed", async (req, res) => {
  try {
    const defaultCommunities = [
      {
        name: "General Health",
        slug: "general-health",
        description: "Discuss general health topics, wellness tips, and healthy lifestyle choices",
        icon: "🏥",
        color: "#2F3C96",
        tags: ["health", "wellness", "lifestyle", "general"],
        isOfficial: true,
      },
      {
        name: "Cancer Support",
        slug: "cancer-support",
        description: "A supportive community for cancer patients, survivors, and caregivers",
        icon: "🎗️",
        color: "#E91E63",
        tags: ["cancer", "oncology", "support", "treatment"],
        isOfficial: true,
      },
      {
        name: "Mental Health",
        slug: "mental-health",
        description: "Open discussions about mental health, coping strategies, and emotional wellbeing",
        icon: "🧠",
        color: "#9C27B0",
        tags: ["mental health", "anxiety", "depression", "therapy", "wellbeing"],
        isOfficial: true,
      },
      {
        name: "Diabetes Management",
        slug: "diabetes-management",
        description: "Tips, experiences, and support for managing diabetes",
        icon: "💉",
        color: "#2196F3",
        tags: ["diabetes", "blood sugar", "insulin", "diet"],
        isOfficial: true,
      },
      {
        name: "Heart Health",
        slug: "heart-health",
        description: "Discussions about cardiovascular health, heart conditions, and prevention",
        icon: "❤️",
        color: "#F44336",
        tags: ["heart", "cardiovascular", "blood pressure", "cholesterol"],
        isOfficial: true,
      },
      {
        name: "Nutrition & Diet",
        slug: "nutrition-diet",
        description: "Share recipes, nutrition tips, and dietary advice",
        icon: "🥗",
        color: "#4CAF50",
        tags: ["nutrition", "diet", "food", "healthy eating"],
        isOfficial: true,
      },
      {
        name: "Fitness & Exercise",
        slug: "fitness-exercise",
        description: "Workout routines, fitness tips, and exercise motivation",
        icon: "💪",
        color: "#FF9800",
        tags: ["fitness", "exercise", "workout", "strength"],
        isOfficial: true,
      },
      {
        name: "Clinical Trials",
        slug: "clinical-trials",
        description: "Information and discussions about participating in clinical trials",
        icon: "🔬",
        color: "#673AB7",
        tags: ["clinical trials", "research", "studies", "participation"],
        isOfficial: true,
      },
      {
        name: "Chronic Pain",
        slug: "chronic-pain",
        description: "Support and management strategies for chronic pain conditions",
        icon: "🩹",
        color: "#795548",
        tags: ["chronic pain", "pain management", "fibromyalgia", "arthritis"],
        isOfficial: true,
      },
      {
        name: "Autoimmune Conditions",
        slug: "autoimmune-conditions",
        description: "Community for those dealing with autoimmune diseases",
        icon: "🛡️",
        color: "#00BCD4",
        tags: ["autoimmune", "lupus", "rheumatoid", "multiple sclerosis"],
        isOfficial: true,
      },
      {
        name: "Cardiology",
        slug: "cardiology",
        description: "Heart disease, cardiac care, and cardiovascular research",
        icon: "❤️",
        color: "#F44336",
        tags: ["cardiology", "heart", "cardiovascular", "cardiac"],
        isOfficial: true,
      },
      {
        name: "Oncology",
        slug: "oncology",
        description: "Cancer treatment, oncology research, and patient care",
        icon: "🧬",
        color: "#E91E63",
        tags: ["oncology", "cancer", "tumors", "treatment"],
        isOfficial: true,
      },
      {
        name: "Neurology",
        slug: "neurology",
        description: "Brain health, neurological disorders, and neuroscience research",
        icon: "🧠",
        color: "#9C27B0",
        tags: ["neurology", "brain", "neurological", "neuroscience"],
        isOfficial: true,
      },
      {
        name: "Cancer Research",
        slug: "cancer-research",
        description: "Latest cancer research, breakthroughs, and clinical trials",
        icon: "🧬",
        color: "#E91E63",
        tags: ["cancer research", "oncology research", "clinical trials", "breakthroughs"],
        isOfficial: true,
      },
      // Researcher communities
      {
        name: "Basic & Pre-clinical Research",
        slug: "basic-preclinical-research",
        description: "Molecular biology, animal models, gene editing (CRISPR), and cell signaling",
        icon: "🔬",
        color: "#673AB7",
        tags: ["molecular biology", "animal models", "CRISPR", "gene editing", "cell signaling", "pre-clinical"],
        isOfficial: true,
        communityType: "researcher",
        createdByResearcher: false,
      },
      {
        name: "Translational Research",
        slug: "translational-research",
        description: "Biomarker discovery, drug screening, and moving lab findings into human relevance",
        icon: "🧪",
        color: "#009688",
        tags: ["biomarker discovery", "drug screening", "translational research", "lab to clinic"],
        isOfficial: true,
        communityType: "researcher",
        createdByResearcher: false,
      },
    ];

    const created = [];
    for (const community of defaultCommunities) {
      const existing = await Community.findOne({ slug: community.slug });
      if (!existing) {
        const newCommunity = await Community.create(community);
        created.push(newCommunity);
      }
    }

    invalidateCache("communities");

    res.json({
      ok: true,
      message: `Created ${created.length} communities`,
      communities: created,
    });
  } catch (error) {
    console.error("Error seeding communities:", error);
    res.status(500).json({ error: "Failed to seed communities" });
  }
});

// ============================================
// SUBCATEGORY ROUTES
// ============================================

// Get subcategories for a community
router.get("/communities/:communityId/subcategories", async (req, res) => {
  try {
    const { communityId } = req.params;
    const { search } = req.query;

    let query = { parentCommunityId: communityId };
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
        { tags: { $elemMatch: { $regex: search, $options: "i" } } },
      ];
    }

    const subcategories = await Subcategory.find(query)
      .sort({ name: 1 })
      .lean();

    // Get thread counts for each subcategory
    const subcategoryIds = subcategories.map((s) => s._id);
    const threadCounts = await Thread.aggregate([
      { $match: { subcategoryId: { $in: subcategoryIds } } },
      { $group: { _id: "$subcategoryId", count: { $sum: 1 } } },
    ]);
    const threadCountMap = {};
    threadCounts.forEach((item) => {
      threadCountMap[item._id.toString()] = item.count;
    });

    const subcategoriesWithData = subcategories.map((subcategory) => ({
      ...subcategory,
      threadCount: threadCountMap[subcategory._id.toString()] || 0,
    }));

    res.json({ subcategories: subcategoriesWithData });
  } catch (error) {
    console.error("Error fetching subcategories:", error);
    res.status(500).json({ error: "Failed to fetch subcategories" });
  }
});

// Get a single subcategory by ID or slug
router.get("/subcategories/:idOrSlug", async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const { communityId } = req.query;

    let subcategory;
    if (mongoose.Types.ObjectId.isValid(idOrSlug)) {
      subcategory = await Subcategory.findById(idOrSlug)
        .populate("parentCommunityId", "name slug icon color")
        .lean();
    } else {
      const query = { slug: idOrSlug };
      if (communityId) {
        query.parentCommunityId = communityId;
      }
      subcategory = await Subcategory.findOne(query)
        .populate("parentCommunityId", "name slug icon color")
        .lean();
    }

    if (!subcategory) {
      return res.status(404).json({ error: "Subcategory not found" });
    }

    // Get thread count
    const threadCount = await Thread.countDocuments({
      subcategoryId: subcategory._id,
    });

    res.json({
      subcategory: {
        ...subcategory,
        threadCount,
      },
    });
  } catch (error) {
    console.error("Error fetching subcategory:", error);
    res.status(500).json({ error: "Failed to fetch subcategory" });
  }
});

// Create a subcategory (users can create subcategories)
router.post("/communities/:communityId/subcategories", async (req, res) => {
  try {
    const { communityId } = req.params;
    const { name, description, tags, createdBy } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: "name is required" });
    }

    // Check if community exists
    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    // Generate slug from name
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");

    // Check if similar subcategory already exists (duplicate checking)
    const existing = await Subcategory.findOne({
      parentCommunityId: communityId,
      $or: [
        { slug },
        {
          name: { $regex: new RegExp(`^${name.trim()}$`, "i") },
        },
        // Check for similar names (normalized)
        {
          name: {
            $regex: new RegExp(
              name
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]/g, ".*"),
              "i"
            ),
          },
        },
      ],
    });

    if (existing) {
      // Redirect user to existing subcategory
      return res.status(409).json({
        error: "A similar subcategory already exists",
        existingSubcategory: existing,
        redirect: true,
      });
    }

    // Validate name length
    if (name.trim().length < 2) {
      return res.status(400).json({
        error: "Subcategory name must be at least 2 characters",
      });
    }

    if (name.trim().length > 100) {
      return res.status(400).json({
        error: "Subcategory name must be less than 100 characters",
      });
    }

    const subcategory = await Subcategory.create({
      name: name.trim(),
      slug,
      description: description?.trim() || "",
      parentCommunityId: communityId,
      tags: tags || [], // MeSH terminology tags
      createdBy,
      isOfficial: false,
    });

    invalidateCache(`communities:${communityId}`);

    res.json({
      ok: true,
      subcategory,
      message: "Subcategory created successfully",
    });
  } catch (error) {
    if (error.code === 11000) {
      // Duplicate key error
      return res.status(409).json({
        error: "A subcategory with this name already exists in this community",
      });
    }
    console.error("Error creating subcategory:", error);
    res.status(500).json({ error: "Failed to create subcategory" });
  }
});

// Get MeSH terminology suggestions for tags (placeholder - would integrate with MeSH API)
router.get("/mesh/suggestions", async (req, res) => {
  try {
    const { term } = req.query;

    if (!term || term.trim().length < 2) {
      return res.json({ suggestions: [] });
    }

    // Placeholder for MeSH API integration
    // In production, this would call the MeSH API:
    // https://id.nlm.nih.gov/mesh/query?label={term}
    // For now, return common medical terms based on the query

    const commonMeSHTerms = {
      cancer: [
        "Neoplasms",
        "Carcinoma",
        "Oncology",
        "Tumor",
        "Metastasis",
        "Chemotherapy",
        "Radiotherapy",
      ],
      treatment: [
        "Therapy",
        "Treatment",
        "Medical Treatment",
        "Pharmacological Therapy",
        "Surgical Procedures",
      ],
      symptoms: [
        "Signs and Symptoms",
        "Pain",
        "Fatigue",
        "Side Effects",
        "Adverse Effects",
      ],
      outcomes: [
        "Treatment Outcome",
        "Patient Outcome Assessment",
        "Prognosis",
        "Survival Rate",
      ],
      diagnosis: [
        "Diagnosis",
        "Diagnostic Imaging",
        "Laboratory Techniques and Procedures",
        "Biopsy",
      ],
    };

    const normalizedTerm = term.toLowerCase().trim();
    let suggestions = [];

    // Simple keyword matching for common terms
    for (const [key, values] of Object.entries(commonMeSHTerms)) {
      if (normalizedTerm.includes(key) || key.includes(normalizedTerm)) {
        suggestions = [...suggestions, ...values];
      }
    }

    // Filter suggestions by term match
    if (suggestions.length === 0) {
      suggestions = Object.values(commonMeSHTerms)
        .flat()
        .filter((t) => t.toLowerCase().includes(normalizedTerm));
    }

    // Remove duplicates and limit to 10
    suggestions = [...new Set(suggestions)].slice(0, 10);

    res.json({ suggestions });
  } catch (error) {
    console.error("Error fetching MeSH suggestions:", error);
    res.status(500).json({ error: "Failed to fetch MeSH suggestions" });
  }
});

export default router;

