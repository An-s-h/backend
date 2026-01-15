import { Router } from "express";
import mongoose from "mongoose";
import { Community } from "../models/Community.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Notification } from "../models/Notification.js";

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

// ============================================
// COMMUNITY ROUTES
// ============================================

// Get all communities with member counts and thread counts
router.get("/communities", async (req, res) => {
  try {
    const { userId, search } = req.query;
    const cacheKey = `communities:all:${search || ""}`;
    
    let cached = getCache(cacheKey);
    if (cached && !userId) {
      return res.json({ communities: cached });
    }

    let query = {};
    if (search) {
      query = {
        $or: [
          { name: { $regex: search, $options: "i" } },
          { description: { $regex: search, $options: "i" } },
          { tags: { $elemMatch: { $regex: search, $options: "i" } } },
        ],
      };
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
    const { sort = "recent", page = 1, limit = 20 } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let sortOption = { createdAt: -1 };
    if (sort === "popular") {
      sortOption = { viewCount: -1 };
    } else if (sort === "top") {
      // Will sort by vote score after aggregation
    }

    const threads = await Thread.find({ communityId })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort(sortOption)
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get reply counts
    const threadIds = threads.map((t) => t._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });

    const threadsWithData = threads.map((thread) => ({
      ...thread,
      replyCount: replyCountMap[thread._id.toString()] || 0,
      voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
    }));

    // Sort by vote score if top
    if (sort === "top") {
      threadsWithData.sort((a, b) => b.voteScore - a.voteScore);
    }

    const total = await Thread.countDocuments({ communityId });

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

    const threads = await Thread.find({ communityId: { $in: communityIds } })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Get reply counts
    const threadIds = threads.map((t) => t._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });

    const threadsWithData = threads.map((thread) => ({
      ...thread,
      replyCount: replyCountMap[thread._id.toString()] || 0,
      voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
    }));

    const total = await Thread.countDocuments({ communityId: { $in: communityIds } });

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
      // Return popular threads if no interests
      const threads = await Thread.find({})
        .populate("authorUserId", "username email")
        .populate("communityId", "name slug icon color")
        .sort({ viewCount: -1 })
        .limit(parseInt(limit))
        .lean();

      const threadIds = threads.map((t) => t._id);
      const replyCounts = await Reply.aggregate([
        { $match: { threadId: { $in: threadIds } } },
        { $group: { _id: "$threadId", count: { $sum: 1 } } },
      ]);
      const replyCountMap = {};
      replyCounts.forEach((item) => {
        replyCountMap[item._id.toString()] = item.count;
      });

      return res.json({
        threads: threads.map((t) => ({
          ...t,
          replyCount: replyCountMap[t._id.toString()] || 0,
          voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
        })),
      });
    }

    // Find communities matching user interests
    const matchingCommunities = await Community.find({
      tags: { $in: interests.map((i) => new RegExp(i, "i")) },
    }).lean();

    const communityIds = matchingCommunities.map((c) => c._id);

    // Get threads from matching communities or with matching keywords
    const threads = await Thread.find({
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
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });

    res.json({
      threads: threads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
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

    // Get threads created by user
    const userThreads = await Thread.find({ authorUserId: userId })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .lean();

    // Get threads where user has replied
    const userReplies = await Reply.find({ authorUserId: userId }).distinct("threadId");
    const repliedThreads = await Thread.find({
      _id: { $in: userReplies },
      authorUserId: { $ne: userId }, // Exclude threads already in userThreads
    })
      .populate("authorUserId", "username email")
      .populate("communityId", "name slug icon color")
      .sort({ createdAt: -1 })
      .lean();

    // Combine and deduplicate
    const allThreads = [...userThreads, ...repliedThreads];
    allThreads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const limitedThreads = allThreads.slice(0, parseInt(limit));

    // Get reply counts
    const threadIds = limitedThreads.map((t) => t._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });

    res.json({
      threads: limitedThreads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
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

    // Get reply counts
    const threadIds = threads.map((t) => t._id);
    const replyCounts = await Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]);
    const replyCountMap = {};
    replyCounts.forEach((item) => {
      replyCountMap[item._id.toString()] = item.count;
    });

    const total = await Thread.countDocuments(matchQuery);

    res.json({
      threads: threads.map((t) => ({
        ...t,
        replyCount: replyCountMap[t._id.toString()] || 0,
        voteScore: (t.upvotes?.length || 0) - (t.downvotes?.length || 0),
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
    const { authorUserId, authorRole, title, body } = req.body;

    if (!authorUserId || !authorRole || !title || !body) {
      return res.status(400).json({
        error: "authorUserId, authorRole, title, body required",
      });
    }

    const community = await Community.findById(communityId);
    if (!community) {
      return res.status(404).json({ error: "Community not found" });
    }

    const thread = await Thread.create({
      communityId,
      categoryId: communityId, // For backward compatibility
      authorUserId,
      authorRole,
      title,
      body,
    });

    const populatedThread = await Thread.findById(thread._id)
      .populate("communityId", "name slug icon color")
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
    const { name, description, icon, color, tags, createdBy, isOfficial } = req.body;

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

export default router;

