import { Router } from "express";
import mongoose from "mongoose";
import { ForumCategory } from "../models/ForumCategory.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Notification } from "../models/Notification.js";
import { Community } from "../models/Community.js";
import { verifySession } from "../middleware/auth.js";
import { enrichAuthorsWithDisplayName, getResearcherDisplayName } from "../utils/researcherDisplayName.js";

const router = Router();

// Cache implementation
const cache = new Map();
const CACHE_TTL = {
  categories: 1000 * 60 * 5, // 5 minutes
  threads: 1000 * 60 * 2, // 2 minutes
  threadDetails: 1000 * 60 * 1, // 1 minute
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

  // Cleanup old cache entries if cache gets too large (prevent memory leaks)
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

// Normalize condition tags coming from queries/bodies
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
    .slice(0, 10); // avoid excessively long payloads
}

// Helper to ensure a real Thread exists for dummy/sample forum posts
// This allows interactions (replies, votes) on sample threads to be persisted
// without creating fake user profiles for dummy authors
async function ensureRealThreadFromDummyId(threadId, dummyThreadData = null) {
  // If it's a real ObjectId, just find and return it
  if (!threadId.startsWith("dummy-thread-") && !threadId.startsWith("dummy-rthread-")) {
    if (!mongoose.Types.ObjectId.isValid(threadId)) {
      return null;
    }
    return await Thread.findById(threadId);
  }

  // Check if we already promoted this dummy thread to a real one
  let thread = await Thread.findOne({ dummyKey: threadId });
  if (thread) return thread;

  // Need to create a real Thread for this dummy
  // Require dummyThreadData from frontend on first interaction
  if (!dummyThreadData) {
    throw new Error("First interaction with dummy thread requires dummyThreadData");
  }

  // Find or create a service account user for dummy thread ownership (username matches dummy forum: collabiora_forum)
  const FORUM_HELPER_EMAIL = "forum-helper@curalink.internal";
  const FORUM_HELPER_USERNAME = "collabiora_forum";
  let serviceUser = await User.findOne({ email: FORUM_HELPER_EMAIL });
  if (!serviceUser) {
    serviceUser = await User.create({
      email: FORUM_HELPER_EMAIL,
      username: FORUM_HELPER_USERNAME,
      role: "patient",
      isServiceAccount: true,
    });
  } else if (serviceUser.username === "CuraLink Forum Helper") {
    serviceUser.username = FORUM_HELPER_USERNAME;
    await serviceUser.save();
  }

  // Find the community by slug if provided
  let communityId = null;
  if (dummyThreadData.communitySlug) {
    const community = await Community.findOne({ slug: dummyThreadData.communitySlug });
    if (community) {
      communityId = community._id;
    }
  }

  // Normalize title for matching (trim, collapse whitespace, same forum = same question)
  const normalizedTitle = (dummyThreadData.title || "")
    .trim()
    .replace(/\s+/g, " ");

  if (normalizedTitle) {
    // If a real thread with the same title already exists in this community, link the dummy to it
    // so we don't create a duplicate (same forum appearing twice: one by real user, one by collabiora_forum)
    const escaped = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const existingQuery = {
      title: new RegExp(`^\\s*${escaped}\\s*$`, "i"),
      $or: [{ dummyKey: { $exists: false } }, { dummyKey: null }, { dummyKey: "" }],
      isResearcherForum: !!dummyThreadData.isResearcherForum,
      communityId: communityId || null,
    };
    const existingThread = await Thread.findOne(existingQuery);
    if (existingThread) {
      existingThread.dummyKey = threadId;
      await existingThread.save();
      invalidateCache("forums:threads:");
      invalidateCache("forums:thread:");
      console.log(`[Forums] Linked dummy ${threadId} to existing thread ${existingThread._id} (same title), no duplicate created`);
      return existingThread;
    }
  }

  // No existing thread with same title — create a new one (service user as author)
  const initialUpvotes = [];
  const initialVoteScore = dummyThreadData.voteScore || 0;
  for (let i = 0; i < Math.max(0, initialVoteScore); i++) {
    initialUpvotes.push(serviceUser._id);
  }

  thread = await Thread.create({
    dummyKey: threadId,
    communityId,
    authorUserId: serviceUser._id,
    authorRole: dummyThreadData.authorRole || "patient",
    title: dummyThreadData.title || "Sample Question",
    body: dummyThreadData.body || "",
    tags: dummyThreadData.tags || [],
    conditions: dummyThreadData.conditions || [],
    onlyResearchersCanReply: !!dummyThreadData.onlyResearchersCanReply,
    isResearcherForum: !!dummyThreadData.isResearcherForum,
    upvotes: initialUpvotes,
    downvotes: [],
    originalAuthorUsername: dummyThreadData.originalAuthorUsername || null,
    originalAuthorHandle: dummyThreadData.originalAuthorHandle || null,
  });

  // Invalidate caches so thread list refetch returns the new thread (like persists like reply flow)
  invalidateCache("forums:threads:");
  invalidateCache("forums:thread:");
  console.log(`[Forums] Promoted dummy thread ${threadId} to new real Thread ${thread._id} with initial vote score ${initialVoteScore}`);
  return thread;
}

// Get all categories with thread counts
router.get("/forums/categories", async (_req, res) => {
  const cacheKey = "forums:categories";
  const cached = getCache(cacheKey);
  if (cached) {
    return res.json({ categories: cached });
  }

  const categories = await ForumCategory.find({}).sort({ name: 1 }).lean();
  
  // Get thread counts for each category
  const categoryIds = categories.map((cat) => cat._id);
  const threadCounts = await Thread.aggregate([
    { $match: { categoryId: { $in: categoryIds } } },
    { $group: { _id: "$categoryId", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  threadCounts.forEach((item) => {
    countMap[item._id.toString()] = item.count;
  });

  // Add thread count to each category
  const categoriesWithCounts = categories.map((category) => ({
    ...category,
    threadCount: countMap[category._id.toString()] || 0,
  }));

  setCache(cacheKey, categoriesWithCounts, CACHE_TTL.categories);
  res.json({ categories: categoriesWithCounts });
});

// Get threads with populated data
router.get("/forums/threads", async (req, res) => {
  const { categoryId, condition, userId } = req.query;
  const normalizedConditions = normalizeConditions(condition);
  const conditionKey =
    normalizedConditions.length > 0
      ? normalizedConditions.join("|").toLowerCase()
      : "all";
  const cacheKey = `forums:threads:${categoryId || "all"}:${conditionKey}`;
  // Skip cache when userId provided (per-user hasCurrentUserReplied)
  const cached = !userId ? getCache(cacheKey) : null;
  if (cached) {
    return res.json({ threads: cached });
  }

  const q = {
    ...(categoryId ? { categoryId } : {}),
    ...(normalizedConditions.length > 0
      ? { conditions: { $in: normalizedConditions } }
      : {}),
    // Exclude threads from Researcher Forums
    isResearcherForum: { $ne: true },
  };
  const threads = await Thread.find(q)
    .populate("categoryId", "name slug")
    .populate("authorUserId", "username email picture handle nameHidden role")
    .sort({ createdAt: -1 })
    .lean();

  // Enrich researcher authors with displayName (Dr. Name, MD PHD)
  const authorIds = [...new Set(threads.map((t) => t.authorUserId?._id?.toString()).filter(Boolean))];
  const researcherIds = authorIds.filter((id) => {
    const author = threads.find((t) => t.authorUserId?._id?.toString() === id)?.authorUserId;
    return author?.role === "researcher";
  });
  if (researcherIds.length > 0) {
    const profiles = await Profile.find({ userId: { $in: researcherIds } }).lean();
    const profileMap = {};
    profiles.forEach((p) => {
      profileMap[p.userId.toString()] = p;
    });
    enrichAuthorsWithDisplayName(threads, profileMap);
  }

  // Get reply counts and researcher-reply flags for each thread
  const threadIds = threads.map((t) => t._id);
  const aggregates = [
    Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]),
    Reply.aggregate([
      { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
      { $group: { _id: "$threadId" } },
    ]),
  ];
  // When userId provided, also get threads where current user (researcher) replied
  if (userId && mongoose.Types.ObjectId.isValid(userId)) {
    aggregates.push(
      Reply.aggregate([
        {
          $match: {
            threadId: { $in: threadIds },
            authorUserId: new mongoose.Types.ObjectId(userId),
            authorRole: "researcher",
          },
        },
        { $group: { _id: "$threadId" } },
      ])
    );
  }
  const aggResults = await Promise.all(aggregates);

  const countMap = {};
  aggResults[0].forEach((item) => {
    countMap[item._id.toString()] = item.count;
  });
  const researcherReplyThreadIds = new Set(
    aggResults[1].map((r) => r._id.toString())
  );
  const currentUserReplyThreadIds = new Set(
    aggResults.length > 2 ? aggResults[2].map((r) => r._id.toString()) : []
  );

  const threadsWithCounts = threads.map((thread) => ({
    ...thread,
    replyCount: countMap[thread._id.toString()] || 0,
    voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
    hasResearcherReply:
      researcherReplyThreadIds.has(thread._id.toString()) ||
      thread.authorRole === "researcher",
    hasCurrentUserReplied: currentUserReplyThreadIds.has(thread._id.toString()),
  }));

  if (!userId) setCache(cacheKey, threadsWithCounts, CACHE_TTL.threads);
  
  // Also return list of promoted dummy thread keys so frontend can filter them out
  const promotedDummyKeys = threads
    .filter(t => t.dummyKey)
    .map(t => t.dummyKey);
  
  res.json({ threads: threadsWithCounts, promotedDummyKeys });
});

// Get researcher forum threads (for Researcher Forums page)
router.get("/researcher-forums/threads", async (req, res) => {
  const { communityId, subcategoryId, skipCache } = req.query;
  const cacheKey = `researcher-forums:threads:${communityId || "all"}:${subcategoryId || "all"}`;
  const cached = skipCache !== "true" ? getCache(cacheKey) : null;
  if (cached) {
    return res.json({ threads: cached });
  }

  const q = {
    // Show threads from Researcher Forums OR threads by researchers
    $or: [
      { isResearcherForum: true },
      { authorRole: "researcher" },
    ],
    ...(communityId ? { communityId } : {}),
    ...(subcategoryId ? { subcategoryId } : {}),
  };

  const threads = await Thread.find(q)
    .populate("communityId", "name slug icon color")
    .populate("subcategoryId", "name slug")
    .populate("authorUserId", "username email picture handle nameHidden role")
    .sort({ createdAt: -1 })
    .lean();

  // Enrich researcher authors with displayName (Dr. Name, MD PHD)
  const authorIds = [...new Set(threads.map((t) => t.authorUserId?._id?.toString()).filter(Boolean))];
  const researcherIds = authorIds.filter((id) => {
    const author = threads.find((t) => t.authorUserId?._id?.toString() === id)?.authorUserId;
    return author?.role === "researcher";
  });
  if (researcherIds.length > 0) {
    const profiles = await Profile.find({ userId: { $in: researcherIds } }).lean();
    const profileMap = {};
    profiles.forEach((p) => {
      profileMap[p.userId.toString()] = p;
    });
    enrichAuthorsWithDisplayName(threads, profileMap);
  }

  // Get reply counts and researcher-reply flags
  const threadIds = threads.map((t) => t._id);
  const [replyCounts, researcherReplyThreadIds] = await Promise.all([
    Reply.aggregate([
      { $match: { threadId: { $in: threadIds } } },
      { $group: { _id: "$threadId", count: { $sum: 1 } } },
    ]),
    Reply.aggregate([
      { $match: { threadId: { $in: threadIds }, authorRole: "researcher" } },
      { $group: { _id: "$threadId" } },
    ]),
  ]);

  const countMap = {};
  replyCounts.forEach((item) => {
    countMap[item._id.toString()] = item.count;
  });
  const researcherReplySet = new Set(researcherReplyThreadIds.map((r) => r._id.toString()));

  const threadsWithCounts = threads.map((thread) => ({
    ...thread,
    replyCount: countMap[thread._id.toString()] || 0,
    hasResearcherReply: researcherReplySet.has(thread._id.toString()) || thread.authorRole === "researcher",
    voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
  }));

  if (skipCache !== "true") {
    setCache(cacheKey, threadsWithCounts, CACHE_TTL.threads);
  }
  
  // Also return list of promoted dummy thread keys so frontend can filter them out
  const promotedDummyKeys = threads
    .filter(t => t.dummyKey)
    .map(t => t.dummyKey);
  
  res.json({ threads: threadsWithCounts, promotedDummyKeys });
});

// Get single thread with all replies in tree structure
router.get("/forums/threads/:threadId", async (req, res) => {
  const { threadId } = req.params;
  const cacheKey = `forums:thread:${threadId}`;
  const cached = getCache(cacheKey);
  if (cached) {
    // Still increment view count but return cached data
    await Thread.findByIdAndUpdate(threadId, { $inc: { viewCount: 1 } }).catch(() => {});
    return res.json(cached);
  }

  const thread = await Thread.findById(threadId)
    .populate("categoryId", "name slug")
    .populate("authorUserId", "username email picture handle nameHidden role")
    .lean();

  if (!thread) return res.status(404).json({ error: "Thread not found" });

  // Increment view count
  await Thread.findByIdAndUpdate(threadId, { $inc: { viewCount: 1 } });

  // Get all replies with populated data
  const replies = await Reply.find({ threadId })
    .populate("authorUserId", "username email picture handle nameHidden role")
    .sort({ createdAt: 1 })
    .lean();

  // Get researcher profiles for thread author and reply authors (for displayName + specialties)
  const replyResearcherIds = replies
    .filter((r) => r.authorRole === "researcher")
    .map((r) => r.authorUserId?._id || r.authorUserId);
  const threadAuthorId = thread.authorRole === "researcher" && thread.authorUserId?._id
    ? thread.authorUserId._id
    : null;
  const allResearcherIds = [...new Set([
    ...replyResearcherIds.map((id) => id?.toString()).filter(Boolean),
    threadAuthorId?.toString(),
  ].filter(Boolean))];
  const profiles = await Profile.find({ userId: { $in: allResearcherIds } }).lean();
  const profileMap = {};
  profiles.forEach((p) => {
    profileMap[p.userId.toString()] = p;
  });

  enrichAuthorsWithDisplayName([thread], profileMap);
  enrichAuthorsWithDisplayName(replies, profileMap);

  // Build tree structure
  const buildReplyTree = (parentId = null) => {
    return replies
      .filter((reply) => {
        const parent = reply.parentReplyId
          ? reply.parentReplyId.toString()
          : null;
        return parent === (parentId ? parentId.toString() : null);
      })
      .map((reply) => {
        const profile = reply.authorUserId
          ? profileMap[reply.authorUserId._id?.toString() || reply.authorUserId.toString()]
          : null;
        const specialties =
          reply.authorRole === "researcher" && profile
            ? profile.researcher?.specialties || profile.researcher?.interests || []
            : [];

        return {
          ...reply,
          voteScore: (reply.upvotes?.length || 0) - (reply.downvotes?.length || 0),
          specialties,
          children: buildReplyTree(reply._id),
        };
      });
  };

  const replyTree = buildReplyTree();

  const result = {
    thread: {
      ...thread,
      voteScore:
        (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
    },
    replies: replyTree,
  };

  setCache(cacheKey, result, CACHE_TTL.threadDetails);
  res.json(result);
});

// Create new thread
router.post("/forums/threads", async (req, res) => {
  const {
    categoryId,
    authorUserId,
    authorRole,
    title,
    body,
    conditions,
    onlyResearchersCanReply,
    isResearcherForum,
  } = req.body || {};
  if (!categoryId || !authorUserId || !authorRole || !title || !title.trim()) {
    return res.status(400).json({
      error: "categoryId, authorUserId, authorRole, and title are required",
    });
  }
  const normalizedConditions = normalizeConditions(conditions);
  const thread = await Thread.create({
    categoryId,
    authorUserId,
    authorRole,
    title: title.trim(),
    body: (body && body.trim()) || "",
    conditions: normalizedConditions,
    onlyResearchersCanReply: !!onlyResearchersCanReply,
    isResearcherForum: !!isResearcherForum,
  });

  const populatedThread = await Thread.findById(thread._id)
    .populate("categoryId", "name slug")
    .populate("authorUserId", "username email picture handle nameHidden role")
    .lean();

  if (populatedThread?.authorUserId?.role === "researcher") {
    const profile = await Profile.findOne({ userId: populatedThread.authorUserId._id }).lean();
    if (profile?.researcher) {
      populatedThread.authorUserId.displayName = getResearcherDisplayName(
        populatedThread.authorUserId.username || populatedThread.authorUserId.name,
        profile.researcher
      );
    }
  }

  // If patient creates a thread, notify researchers in matching specialties
  if (authorRole === "patient") {
    const authorProfile = await Profile.findOne({ userId: authorUserId }).lean();
    const patientConditions = authorProfile?.patient?.conditions || [];
    
    if (patientConditions.length > 0) {
      const researchers = await Profile.find({
        role: "researcher",
        $or: [
          { "researcher.specialties": { $in: patientConditions } },
          { "researcher.interests": { $in: patientConditions } },
        ],
      }).lean();

      const author = await User.findById(authorUserId).lean();
      
      for (const researcher of researchers) {
        await Notification.create({
          userId: researcher.userId,
          type: "patient_question",
          relatedUserId: authorUserId,
          relatedItemId: thread._id,
          relatedItemType: "thread",
          title: "New Patient Question",
          message: `${author?.username || "A patient"} asked a question in your specialty: "${title}"`,
          metadata: {
            threadId: thread._id.toString(),
            threadTitle: title,
            conditions: patientConditions,
          },
        });
      }
    }
  }

  // Invalidate thread list cache for this category
  invalidateCache("forums:threads:");
  // Also invalidate categories cache to update thread counts
  invalidateCache("forums:categories");

  res.json({
    ok: true,
    thread: {
      ...populatedThread,
      replyCount: 0,
      voteScore: 0,
    },
  });
});

// Create reply (can be nested)
router.post("/forums/replies", async (req, res) => {
  const {
    threadId,
    parentReplyId,
    authorUserId,
    authorRole,
    body,
    dummyThreadData,
  } = req.body || {};
  if (!threadId || !authorUserId || !authorRole || !body) {
    return res
      .status(400)
      .json({ error: "threadId, authorUserId, authorRole, body required" });
  }

  try {
    const thread = await ensureRealThreadFromDummyId(threadId, dummyThreadData);
    if (!thread) return res.status(404).json({ error: "thread not found" });

    // Use the real thread's ObjectId for creating the reply (not the dummy key)
    const realThreadId = thread._id;

    // If creator chose "only researchers should reply", only researchers can reply
    if (thread.onlyResearchersCanReply && authorRole !== "researcher") {
      return res
        .status(403)
        .json({ error: "Only researchers can reply to this thread" });
    }
    // Otherwise: patients can reply to patients or researchers; researchers can reply to any thread

    // If replying to another reply, check if it exists
    if (parentReplyId) {
      const parentReply = await Reply.findById(parentReplyId);
      if (!parentReply)
        return res.status(404).json({ error: "Parent reply not found" });
    }

    const reply = await Reply.create({
      threadId: realThreadId,
      parentReplyId: parentReplyId || null,
      authorUserId,
      authorRole,
      body,
    });

    const populatedReply = await Reply.findById(reply._id)
      .populate("authorUserId", "username email picture handle nameHidden role")
      .lean();

    // Get researcher profile for specialties and displayName if author is researcher
    let specialties = [];
    if (authorRole === "researcher") {
      const profile = await Profile.findOne({ userId: authorUserId }).lean();
      if (profile?.researcher) {
        specialties =
          profile.researcher?.specialties || profile.researcher?.interests || [];
        populatedReply.authorUserId.displayName = getResearcherDisplayName(
          populatedReply.authorUserId.username || populatedReply.authorUserId.name,
          profile.researcher
        );
      }
    }

    // Create notification for thread author (if reply author is different)
    if (thread.authorUserId.toString() !== authorUserId.toString()) {
      const replyAuthor = await User.findById(authorUserId).lean();
      const notificationType = authorRole === "researcher" ? "researcher_replied" : "new_reply";
      
      await Notification.create({
        userId: thread.authorUserId,
        type: notificationType,
        relatedUserId: authorUserId,
        relatedItemId: realThreadId,
        relatedItemType: "thread",
        title: authorRole === "researcher" ? "Researcher Replied" : "New Reply",
        message: `${replyAuthor?.username || "Someone"} replied to your thread: "${thread.title}"`,
        metadata: {
          threadTitle: thread.title,
          threadId: realThreadId.toString(),
          replyId: reply._id.toString(),
        },
      });
    }

    // If replying to another reply, notify the parent reply author
    if (parentReplyId) {
      const parentReply = await Reply.findById(parentReplyId).lean();
      if (parentReply && parentReply.authorUserId.toString() !== authorUserId.toString()) {
        const replyAuthor = await User.findById(authorUserId).lean();
        await Notification.create({
          userId: parentReply.authorUserId,
          type: "new_reply",
          relatedUserId: authorUserId,
          relatedItemId: parentReplyId,
          relatedItemType: "reply",
          title: "New Reply",
          message: `${replyAuthor?.username || "Someone"} replied to your comment`,
          metadata: {
            threadId: realThreadId.toString(),
            replyId: reply._id.toString(),
          },
        });
      }
    }

    // Invalidate caches
    invalidateCache(`forums:thread:${realThreadId}`); // Invalidate thread details
    invalidateCache("forums:threads:"); // Invalidate all thread lists (they show reply counts)
    invalidateCache("forums:categories"); // Update thread counts in categories

    res.json({
      ok: true,
      reply: {
        ...populatedReply,
        voteScore: 0,
        children: [],
        specialties,
      },
    });
  } catch (error) {
    console.error("Error creating reply:", error);
    res.status(500).json({ error: error.message || "Failed to create reply" });
  }
});

// Vote on a reply
router.post("/forums/replies/:replyId/vote", async (req, res) => {
  const { replyId } = req.params;
  const { userId, voteType } = req.body || {}; // voteType: 'upvote' or 'downvote'

  if (!userId || !voteType) {
    return res
      .status(400)
      .json({ error: "userId and voteType (upvote/downvote/neutral) required" });
  }

  const reply = await Reply.findById(replyId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const rid = reply._id;

  // Atomic update: remove from both, then add to the correct one (neutral = remove only)
  await Reply.findByIdAndUpdate(rid, { $pull: { upvotes: userIdObj, downvotes: userIdObj } });
  if (voteType === "upvote") {
    await Reply.findByIdAndUpdate(rid, { $addToSet: { upvotes: userIdObj } });
  } else if (voteType === "downvote") {
    await Reply.findByIdAndUpdate(rid, { $addToSet: { downvotes: userIdObj } });
  }
  // voteType === "neutral" = already pulled from both, no add

  // Create notification for reply author if upvoted (and not by themselves)
  if (voteType === "upvote" && reply.authorUserId.toString() !== userId.toString()) {
    const voter = await User.findById(userId).lean();
    await Notification.create({
      userId: reply.authorUserId,
      type: "reply_upvoted",
      relatedUserId: userId,
      relatedItemId: replyId,
      relatedItemType: "reply",
      title: "Reply Upvoted",
      message: `${voter?.username || "Someone"} upvoted your reply`,
      metadata: {
        replyId: replyId.toString(),
        threadId: reply.threadId.toString(),
      },
    });
  }

  // Return persisted state so frontend gets correct upvotes/downvotes
  const fresh = await Reply.findById(reply._id).select("upvotes downvotes").lean();
  const upvotes = (fresh?.upvotes || []).map((id) => id.toString());
  const downvotes = (fresh?.downvotes || []).map((id) => id.toString());
  res.json({
    ok: true,
    voteScore: upvotes.length - downvotes.length,
    upvotes,
    downvotes,
  });
});

// Update reply (owner only)
router.patch("/forums/replies/:replyId", async (req, res) => {
  const { replyId } = req.params;
  const { userId, body } = req.body || {};

  if (!userId || body === undefined) {
    return res
      .status(400)
      .json({ error: "userId and body required" });
  }

  const reply = await Reply.findById(replyId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });

  const authorId = reply.authorUserId?.toString?.() || reply.authorUserId?.toString?.();
  if (authorId !== userId.toString()) {
    return res.status(403).json({ error: "You can only edit your own reply" });
  }

  reply.body = String(body).trim();
  if (!reply.body) {
    return res.status(400).json({ error: "Body cannot be empty" });
  }
  await reply.save();

  invalidateCache(`forums:thread:${reply.threadId}`);
  invalidateCache("forums:threads:");

  const populated = await Reply.findById(reply._id)
    .populate("authorUserId", "username email picture handle nameHidden role")
    .lean();

  res.json({
    ok: true,
    reply: {
      ...populated,
      voteScore: (populated.upvotes?.length || 0) - (populated.downvotes?.length || 0),
    },
  });
});

// Delete reply and all nested children (recursive); returns count of deleted replies
async function deleteReplyAndDescendants(replyId) {
  const reply = await Reply.findById(replyId);
  if (!reply) return 0;
  const children = await Reply.find({ parentReplyId: replyId }).lean();
  let count = 1;
  for (const child of children) {
    count += await deleteReplyAndDescendants(child._id);
  }
  await Reply.findByIdAndDelete(replyId);
  return count;
}

// Delete thread (owner only)
router.delete("/forums/threads/:threadId", verifySession, async (req, res) => {
  try {
    const { threadId } = req.params;
    const currentUserId = req.user?._id?.toString?.() || req.user?.id?.toString?.();
    if (!currentUserId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const thread = await Thread.findById(threadId);
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const authorId = thread.authorUserId?.toString?.() || thread.authorUserId?.toString?.();
    if (authorId !== currentUserId) {
      return res.status(403).json({ error: "You can only delete your own thread" });
    }

    await Reply.deleteMany({ threadId });
    await Thread.findByIdAndDelete(threadId);

    invalidateCache(`forums:thread:${threadId}`);
    invalidateCache("forums:threads:");
    invalidateCache("forums:categories");

    res.json({ ok: true, message: "Thread deleted" });
  } catch (error) {
    console.error("Error deleting thread:", error);
    res.status(500).json({ error: "Failed to delete thread" });
  }
});

router.delete("/forums/replies/:replyId", async (req, res) => {
  const { replyId } = req.params;
  const { userId } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: "userId required" });
  }

  const reply = await Reply.findById(replyId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });

  const authorId = reply.authorUserId?.toString?.() || reply.authorUserId?.toString?.();
  if (authorId !== userId.toString()) {
    return res.status(403).json({ error: "You can only delete your own reply" });
  }

  const threadId = reply.threadId.toString();
  const deletedCount = await deleteReplyAndDescendants(replyId);

  invalidateCache(`forums:thread:${threadId}`);
  invalidateCache("forums:threads:");
  invalidateCache("forums:categories");

  res.json({ ok: true, threadId, deletedCount });
});

// Vote on a thread
router.post("/forums/threads/:threadId/vote", async (req, res) => {
  const { threadId } = req.params;
  const { userId, voteType, dummyThreadData } = req.body || {};

  if (!userId || !voteType) {
    return res
      .status(400)
      .json({ error: "userId and voteType (upvote/downvote/neutral) required" });
  }

  try {
    const thread = await ensureRealThreadFromDummyId(threadId, dummyThreadData);
    if (!thread) return res.status(404).json({ error: "Thread not found" });

    const userIdObj = new mongoose.Types.ObjectId(userId);
    const tid = thread._id;

    // Atomic update: remove from both, then add to the correct one (neutral = remove only)
    await Thread.findByIdAndUpdate(tid, { $pull: { upvotes: userIdObj, downvotes: userIdObj } });
    if (voteType === "upvote") {
      await Thread.findByIdAndUpdate(tid, { $addToSet: { upvotes: userIdObj } });
    } else if (voteType === "downvote") {
      await Thread.findByIdAndUpdate(tid, { $addToSet: { downvotes: userIdObj } });
    }
    // voteType === "neutral" = already pulled from both, no add

    // Create notification for thread author if upvoted (and not by themselves)
    if (voteType === "upvote" && thread.authorUserId.toString() !== userId.toString()) {
      const voter = await User.findById(userId).lean();
      await Notification.create({
        userId: thread.authorUserId,
        type: "thread_upvoted",
        relatedUserId: userId,
        relatedItemId: thread._id,
        relatedItemType: "thread",
        title: "Thread Upvoted",
        message: `${voter?.username || "Someone"} upvoted your thread: "${thread.title}"`,
        metadata: {
          threadId: thread._id.toString(),
          threadTitle: thread.title,
        },
      });
    }

    // Return persisted state so frontend always gets correct upvotes/downvotes (avoids stale in-memory array)
    const fresh = await Thread.findById(thread._id).select("upvotes downvotes").lean();
    const upvotes = (fresh?.upvotes || []).map((id) => id.toString());
    const downvotes = (fresh?.downvotes || []).map((id) => id.toString());
    res.json({
      ok: true,
      voteScore: upvotes.length - downvotes.length,
      upvotes,
      downvotes,
    });
  } catch (error) {
    console.error("Error voting on thread:", error);
    res.status(500).json({ error: error.message || "Failed to vote on thread" });
  }
});

export default router;
