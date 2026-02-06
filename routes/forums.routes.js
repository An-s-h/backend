import { Router } from "express";
import mongoose from "mongoose";
import { ForumCategory } from "../models/ForumCategory.js";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Notification } from "../models/Notification.js";

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
  const { categoryId, condition } = req.query;
  const normalizedConditions = normalizeConditions(condition);
  const conditionKey =
    normalizedConditions.length > 0
      ? normalizedConditions.join("|").toLowerCase()
      : "all";
  const cacheKey = `forums:threads:${categoryId || "all"}:${conditionKey}`;
  const cached = getCache(cacheKey);
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
    .populate("authorUserId", "username email picture handle nameHidden")
    .sort({ createdAt: -1 })
    .lean();

  // Get reply counts and researcher-reply flags for each thread
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

  const countMap = {};
  replyCounts.forEach((item) => {
    countMap[item._id.toString()] = item.count;
  });
  const researcherReplyThreadIds = new Set(
    researcherReplies.map((r) => r._id.toString())
  );

  const threadsWithCounts = threads.map((thread) => ({
    ...thread,
    replyCount: countMap[thread._id.toString()] || 0,
    voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
    hasResearcherReply:
      researcherReplyThreadIds.has(thread._id.toString()) ||
      thread.authorRole === "researcher",
  }));

  setCache(cacheKey, threadsWithCounts, CACHE_TTL.threads);
  res.json({ threads: threadsWithCounts });
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
    .populate("authorUserId", "username email picture handle nameHidden")
    .sort({ createdAt: -1 })
    .lean();

  // Get reply counts
  const threadIds = threads.map((t) => t._id);
  const replyCounts = await Reply.aggregate([
    { $match: { threadId: { $in: threadIds } } },
    { $group: { _id: "$threadId", count: { $sum: 1 } } },
  ]);

  const countMap = {};
  replyCounts.forEach((item) => {
    countMap[item._id.toString()] = item.count;
  });

  const threadsWithCounts = threads.map((thread) => ({
    ...thread,
    replyCount: countMap[thread._id.toString()] || 0,
    voteScore: (thread.upvotes?.length || 0) - (thread.downvotes?.length || 0),
  }));

  if (skipCache !== "true") {
    setCache(cacheKey, threadsWithCounts, CACHE_TTL.threads);
  }
  res.json({ threads: threadsWithCounts });
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
    .populate("authorUserId", "username email picture handle nameHidden")
    .lean();

  if (!thread) return res.status(404).json({ error: "Thread not found" });

  // Increment view count
  await Thread.findByIdAndUpdate(threadId, { $inc: { viewCount: 1 } });

  // Get all replies with populated data
  const replies = await Reply.find({ threadId })
    .populate("authorUserId", "username email picture handle nameHidden")
    .sort({ createdAt: 1 })
    .lean();

  // Get researcher specialties for replies
  const researcherIds = replies
    .filter((r) => r.authorRole === "researcher")
    .map((r) => r.authorUserId?._id || r.authorUserId);
  
  const profiles = await Profile.find({ userId: { $in: researcherIds } }).lean();
  const profileMap = {};
  profiles.forEach((p) => {
    profileMap[p.userId.toString()] = p;
  });

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
  if (!categoryId || !authorUserId || !authorRole || !title || !body) {
    return res.status(400).json({
      error: "categoryId, authorUserId, authorRole, title, body required",
    });
  }
  const normalizedConditions = normalizeConditions(conditions);
  const thread = await Thread.create({
    categoryId,
    authorUserId,
    authorRole,
    title,
    body,
    conditions: normalizedConditions,
    onlyResearchersCanReply: !!onlyResearchersCanReply,
    isResearcherForum: !!isResearcherForum,
  });

  const populatedThread = await Thread.findById(thread._id)
    .populate("categoryId", "name slug")
    .populate("authorUserId", "username email picture handle nameHidden")
    .lean();

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
  } = req.body || {};
  if (!threadId || !authorUserId || !authorRole || !body) {
    return res
      .status(400)
      .json({ error: "threadId, authorUserId, authorRole, body required" });
  }

  const thread = await Thread.findById(threadId).lean();
  if (!thread) return res.status(404).json({ error: "thread not found" });

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
    threadId,
    parentReplyId: parentReplyId || null,
    authorUserId,
    authorRole,
    body,
  });

  const populatedReply = await Reply.findById(reply._id)
    .populate("authorUserId", "username email picture handle nameHidden")
    .lean();

  // Get researcher profile for specialties if author is researcher
  let specialties = [];
  if (authorRole === "researcher") {
    const profile = await Profile.findOne({ userId: authorUserId });
    specialties =
      profile?.researcher?.specialties || profile?.researcher?.interests || [];
  }

  // Create notification for thread author (if reply author is different)
  if (thread.authorUserId.toString() !== authorUserId.toString()) {
    const replyAuthor = await User.findById(authorUserId).lean();
    const notificationType = authorRole === "researcher" ? "researcher_replied" : "new_reply";
    
    await Notification.create({
      userId: thread.authorUserId,
      type: notificationType,
      relatedUserId: authorUserId,
      relatedItemId: threadId,
      relatedItemType: "thread",
      title: authorRole === "researcher" ? "Researcher Replied" : "New Reply",
      message: `${replyAuthor?.username || "Someone"} replied to your thread: "${thread.title}"`,
      metadata: {
        threadTitle: thread.title,
        threadId: threadId.toString(),
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
          threadId: threadId.toString(),
          replyId: reply._id.toString(),
        },
      });
    }
  }

  // Invalidate caches
  invalidateCache(`forums:thread:${threadId}`); // Invalidate thread details
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
});

// Vote on a reply
router.post("/forums/replies/:replyId/vote", async (req, res) => {
  const { replyId } = req.params;
  const { userId, voteType } = req.body || {}; // voteType: 'upvote' or 'downvote'

  if (!userId || !voteType) {
    return res
      .status(400)
      .json({ error: "userId and voteType (upvote/downvote) required" });
  }

  const reply = await Reply.findById(replyId);
  if (!reply) return res.status(404).json({ error: "Reply not found" });

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const upvoteIndex = reply.upvotes.findIndex(
    (id) => id.toString() === userIdObj.toString()
  );
  const downvoteIndex = reply.downvotes.findIndex(
    (id) => id.toString() === userIdObj.toString()
  );

  if (voteType === "upvote") {
    if (upvoteIndex > -1) {
      // Already upvoted, remove upvote
      reply.upvotes.splice(upvoteIndex, 1);
    } else {
      // Add upvote, remove downvote if exists
      reply.upvotes.push(userIdObj);
      if (downvoteIndex > -1) {
        reply.downvotes.splice(downvoteIndex, 1);
      }
    }
  } else if (voteType === "downvote") {
    if (downvoteIndex > -1) {
      // Already downvoted, remove downvote
      reply.downvotes.splice(downvoteIndex, 1);
    } else {
      // Add downvote, remove upvote if exists
      reply.downvotes.push(userIdObj);
      if (upvoteIndex > -1) {
        reply.upvotes.splice(upvoteIndex, 1);
      }
    }
  }

  await reply.save();

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

  res.json({
    ok: true,
    voteScore: reply.upvotes.length - reply.downvotes.length,
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
    .populate("authorUserId", "username email picture handle nameHidden")
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
  const { userId, voteType } = req.body || {};

  if (!userId || !voteType) {
    return res
      .status(400)
      .json({ error: "userId and voteType (upvote/downvote) required" });
  }

  const thread = await Thread.findById(threadId);
  if (!thread) return res.status(404).json({ error: "Thread not found" });

  const userIdObj = new mongoose.Types.ObjectId(userId);
  const upvoteIndex = thread.upvotes.findIndex(
    (id) => id.toString() === userIdObj.toString()
  );
  const downvoteIndex = thread.downvotes.findIndex(
    (id) => id.toString() === userIdObj.toString()
  );

  if (voteType === "upvote") {
    if (upvoteIndex > -1) {
      thread.upvotes.splice(upvoteIndex, 1);
    } else {
      thread.upvotes.push(userIdObj);
      if (downvoteIndex > -1) {
        thread.downvotes.splice(downvoteIndex, 1);
      }
    }
  } else if (voteType === "downvote") {
    if (downvoteIndex > -1) {
      thread.downvotes.splice(downvoteIndex, 1);
    } else {
      thread.downvotes.push(userIdObj);
      if (upvoteIndex > -1) {
        thread.upvotes.splice(upvoteIndex, 1);
      }
    }
  }

  await thread.save();

  // Create notification for thread author if upvoted (and not by themselves)
  if (voteType === "upvote" && thread.authorUserId.toString() !== userId.toString()) {
    const voter = await User.findById(userId).lean();
    await Notification.create({
      userId: thread.authorUserId,
      type: "thread_upvoted",
      relatedUserId: userId,
      relatedItemId: threadId,
      relatedItemType: "thread",
      title: "Thread Upvoted",
      message: `${voter?.username || "Someone"} upvoted your thread: "${thread.title}"`,
      metadata: {
        threadId: threadId.toString(),
        threadTitle: thread.title,
      },
    });
  }

  res.json({
    ok: true,
    voteScore: thread.upvotes.length - thread.downvotes.length,
  });
});

export default router;
