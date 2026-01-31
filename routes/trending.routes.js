import { Router } from "express";
import mongoose from "mongoose";
import { Thread } from "../models/Thread.js";
import { Reply } from "../models/Reply.js";
import { Post } from "../models/Post.js";
import { Community } from "../models/Community.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { Profile } from "../models/Profile.js";
import { searchClinicalTrials } from "../services/clinicalTrials.service.js";

const router = Router();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes per section
const TRIALS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour for trials (API is very slow)
const cache = new Map();

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expires) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCached(key, data, customTTL) {
  const ttl = customTTL || CACHE_TTL_MS;
  cache.set(key, { data, expires: Date.now() + ttl });
}

async function fetchExpertsActive(limit = 9) {
  const threadAuthors = await Thread.find({ authorRole: "researcher" })
    .select("authorUserId createdAt")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();
  const replyAuthors = await Reply.find({ authorRole: "researcher" })
    .select("authorUserId createdAt")
    .sort({ createdAt: -1 })
    .limit(100)
    .lean();

  const activityByUser = new Map();
  [...threadAuthors, ...replyAuthors].forEach((item) => {
    const id = item.authorUserId?.toString?.() || item.authorUserId;
    if (!id) return;
    const existing = activityByUser.get(id);
    const created = new Date(item.createdAt).getTime();
    if (!existing || created > existing.latest) {
      activityByUser.set(id, {
        userId: id,
        latest: created,
        count: (existing?.count || 0) + 1,
      });
    } else {
      existing.count += 1;
    }
  });

  const sortedExpertIds = [...activityByUser.entries()]
    .sort((a, b) => b[1].latest - a[1].latest)
    .slice(0, limit)
    .map(([userId]) => new mongoose.Types.ObjectId(userId));

  if (sortedExpertIds.length === 0) return [];

  const profiles = await Profile.find({
    userId: { $in: sortedExpertIds },
    role: "researcher",
  })
    .populate("userId", "username email picture")
    .lean();
  const userMap = new Map(
    profiles.map((p) => [p.userId?._id?.toString?.() ?? p.userId?.toString?.(), p])
  );
  return sortedExpertIds
    .map((id) => {
      const profile = userMap.get(id.toString());
      const contributions = activityByUser.get(id.toString());
      return profile ? { profile, contributions } : null;
    })
    .filter(Boolean)
    .map(({ profile, contributions }) => {
      const user = profile.userId;
      const researcher = profile.researcher || {};
      const loc = researcher.location || {};
      return {
        _id: user._id,
        name: user.username || "Researcher",
        email: user.email,
        picture: user.picture,
        affiliation: researcher.institutionAffiliation,
        location:
          loc.city && loc.country ? `${loc.city}, ${loc.country}` : loc.city || loc.country,
        specialties: researcher.specialties || [],
        interests: researcher.interests || [],
        contributionCount: contributions?.count || 0,
      };
    });
}

async function fetchNewlyRecruitingTrials(limit = 9, userInterest = "") {
  try {
    const result = await searchClinicalTrials({
      q: userInterest || "",
      status: "RECRUITING",
      page: 1,
      pageSize: limit,
    });
    
    return (result.items || []).slice(0, limit);
  } catch (err) {
    console.error("Trending: trials fetch error", err);
    return [];
  }
}

async function fetchTrendingForums(limit = 4) {
  const communities = await Community.find({}).sort({ name: 1 }).lean();
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

  const memberMap = Object.fromEntries(
    memberCounts.map((m) => [m._id.toString(), m.count])
  );
  const threadMap = Object.fromEntries(
    threadCounts.map((t) => [t._id.toString(), t.count])
  );

  return communities
    .map((c) => ({
      ...c,
      memberCount: memberMap[c._id.toString()] || 0,
      threadCount: threadMap[c._id.toString()] || 0,
    }))
    .sort((a, b) => (b.threadCount || 0) - (a.threadCount || 0))
    .slice(0, limit);
}

async function fetchTrendingPosts(limit = 9) {
  const postsAgg = await Post.aggregate([
    { $addFields: { likeCount: { $size: { $ifNull: ["$likes", []] } } } },
    { $sort: { likeCount: -1, createdAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "authorUserId",
        foreignField: "_id",
        as: "authorUser",
      },
    },
    { $unwind: { path: "$authorUser", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "communities",
        localField: "communityId",
        foreignField: "_id",
        as: "community",
      },
    },
    { $unwind: { path: "$community", preserveNullAndEmptyArrays: true } },
    {
      $project: {
        _id: 1,
        content: 1,
        createdAt: 1,
        likeCount: 1,
        viewCount: 1,
        replyCount: 1,
        tags: 1,
        conditions: 1,
        authorUserId: 1,
        attachments: 1,
        "authorUser.username": 1,
        "authorUser.email": 1,
        "authorUser.picture": 1,
        "community.name": 1,
        "community.slug": 1,
        "community._id": 1,
        "community.color": 1,
        "community.icon": 1,
      },
    },
  ]);

  return postsAgg.map((p) => ({
    _id: p._id,
    content: p.content,
    createdAt: p.createdAt,
    likeCount: p.likeCount,
    viewCount: p.viewCount || 0,
    replyCount: p.replyCount || 0,
    tags: p.tags,
    conditions: p.conditions,
    authorUserId: p.authorUserId,
    attachments: p.attachments || [],
    author: p.authorUser
      ? {
          username: p.authorUser.username,
          email: p.authorUser.email,
          picture: p.authorUser.picture,
        }
      : null,
    community: p.community
      ? {
          _id: p.community._id,
          name: p.community.name,
          slug: p.community.slug,
          color: p.community.color,
          icon: p.community.icon,
        }
      : null,
  }));
}

async function fetchTrendingDiscussions(limit = 3) {
  const threads = await Thread.aggregate([
    { $sort: { viewCount: -1, createdAt: -1 } },
    { $limit: limit },
    {
      $lookup: {
        from: "users",
        localField: "authorUserId",
        foreignField: "_id",
        as: "authorUser",
      },
    },
    { $unwind: { path: "$authorUser", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "communities",
        localField: "communityId",
        foreignField: "_id",
        as: "community",
      },
    },
    { $unwind: { path: "$community", preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: "replies",
        localField: "_id",
        foreignField: "threadId",
        as: "replies",
      },
    },
    {
      $addFields: {
        replyCount: { $size: "$replies" },
        voteScore: {
          $subtract: [
            { $size: { $ifNull: ["$upvotes", []] } },
            { $size: { $ifNull: ["$downvotes", []] } },
          ],
        },
      },
    },
    {
      $project: {
        _id: 1,
        title: 1,
        body: 1,
        createdAt: 1,
        viewCount: 1,
        replyCount: 1,
        voteScore: 1,
        authorRole: 1,
        tags: 1,
        "authorUser.username": 1,
        "authorUser._id": 1,
        "community.name": 1,
        "community.slug": 1,
        "community._id": 1,
        "community.icon": 1,
        "community.color": 1,
      },
    },
  ]);

  return threads.map((t) => ({
    _id: t._id,
    title: t.title,
    body: t.body,
    createdAt: t.createdAt,
    viewCount: t.viewCount || 0,
    replyCount: t.replyCount || 0,
    voteScore: t.voteScore || 0,
    authorRole: t.authorRole,
    tags: t.tags,
    author: t.authorUser
      ? {
          username: t.authorUser.username,
          _id: t.authorUser._id,
        }
      : null,
    community: t.community
      ? {
          _id: t.community._id,
          name: t.community.name,
          slug: t.community.slug,
          icon: t.community.icon,
          color: t.community.color,
        }
      : null,
  }));
}

// Section endpoints with per-section cache (faster repeat loads)
router.get("/trending/experts", async (req, res) => {
  try {
    const key = "trending:experts";
    let data = getCached(key);
    if (data) return res.json({ expertsActive: data });
    data = await fetchExpertsActive(9);
    setCached(key, data);
    res.json({ expertsActive: data });
  } catch (err) {
    console.error("Trending experts error:", err);
    res.status(500).json({ error: "Failed to fetch trending experts" });
  }
});

router.get("/trending/trials", async (req, res) => {
  try {
    const userInterest = req.query.interest || "";
    const cacheKey = userInterest ? `trending:trials:${userInterest}` : "trending:trials:general";
    
    let data = getCached(cacheKey);
    
    if (data) {
      return res.json({ newlyRecruitingTrials: data });
    }
    
    data = await fetchNewlyRecruitingTrials(9, userInterest);
    
    setCached(cacheKey, data, TRIALS_CACHE_TTL_MS);
    res.json({ newlyRecruitingTrials: data });
  } catch (err) {
    console.error("Trending trials error:", err);
    res.status(500).json({ error: "Failed to fetch trending trials" });
  }
});

router.get("/trending/forums", async (req, res) => {
  try {
    const key = "trending:forums";
    let data = getCached(key);
    if (data) return res.json({ trendingForums: data });
    data = await fetchTrendingForums(4);
    setCached(key, data);
    res.json({ trendingForums: data });
  } catch (err) {
    console.error("Trending forums error:", err);
    res.status(500).json({ error: "Failed to fetch trending forums" });
  }
});

router.get("/trending/posts", async (req, res) => {
  try {
    const key = "trending:posts";
    let data = getCached(key);
    if (data) return res.json({ trendingPosts: data });
    data = await fetchTrendingPosts(9);
    setCached(key, data);
    res.json({ trendingPosts: data });
  } catch (err) {
    console.error("Trending posts error:", err);
    res.status(500).json({ error: "Failed to fetch trending posts" });
  }
});

router.get("/trending/discussions", async (req, res) => {
  try {
    const key = "trending:discussions";
    let data = getCached(key);
    if (data) return res.json({ trendingDiscussions: data });
    data = await fetchTrendingDiscussions(3);
    setCached(key, data);
    res.json({ trendingDiscussions: data });
  } catch (err) {
    console.error("Trending discussions error:", err);
    res.status(500).json({ error: "Failed to fetch trending discussions" });
  }
});

// Combined endpoint (uses same cache when sections were already fetched)
router.get("/trending", async (req, res) => {
  try {
    const [expertsActive, newlyRecruitingTrials, trendingForums, trendingDiscussions, trendingPosts] =
      await Promise.all([
        getCached("trending:experts") ?? fetchExpertsActive(9),
        getCached("trending:trials") ?? fetchNewlyRecruitingTrials(9),
        getCached("trending:forums") ?? fetchTrendingForums(4),
        getCached("trending:discussions") ?? fetchTrendingDiscussions(3),
        getCached("trending:posts") ?? fetchTrendingPosts(9),
      ]);
    if (!getCached("trending:experts")) setCached("trending:experts", expertsActive);
    if (!getCached("trending:trials")) setCached("trending:trials", newlyRecruitingTrials);
    if (!getCached("trending:forums")) setCached("trending:forums", trendingForums);
    if (!getCached("trending:discussions")) setCached("trending:discussions", trendingDiscussions);
    if (!getCached("trending:posts")) setCached("trending:posts", trendingPosts);
    res.json({
      expertsActive,
      newlyRecruitingTrials,
      trendingForums,
      trendingDiscussions,
      trendingPosts,
    });
  } catch (error) {
    console.error("Error fetching trending data:", error);
    res.status(500).json({ error: "Failed to fetch trending data" });
  }
});

export default router;
