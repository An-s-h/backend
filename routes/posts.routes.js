import { Router } from "express";
import mongoose from "mongoose";
import { Post } from "../models/Post.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Community } from "../models/Community.js";
import { Subcategory } from "../models/Subcategory.js";
import { verifySession } from "../middleware/auth.js";

const router = Router();

// Cache implementation
const cache = new Map();
const CACHE_TTL = {
  posts: 1000 * 60 * 2, // 2 minutes
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

// Normalize condition tags
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

// Get posts with filtering
router.get("/posts", async (req, res) => {
  try {
    const {
      postType, // "patient" or "researcher"
      communityId,
      subcategoryId,
      authorUserId,
      page = "1",
      pageSize = "20",
      userId, // For checking likes
    } = req.query;

    const pageNum = parseInt(page, 10) || 1;
    const limit = parseInt(pageSize, 10) || 20;
    const skip = (pageNum - 1) * limit;

    // Build query
    const query = {};
    if (postType) {
      query.postType = postType;
    }
    if (communityId) {
      query.communityId = new mongoose.Types.ObjectId(communityId);
    }
    if (subcategoryId) {
      query.subcategoryId = new mongoose.Types.ObjectId(subcategoryId);
    }
    if (authorUserId) {
      query.authorUserId = new mongoose.Types.ObjectId(authorUserId);
    }

    // Get posts with pagination
    const posts = await Post.find(query)
      .populate("authorUserId", "username email picture")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Get total count
    const totalCount = await Post.countDocuments(query);

    // Check if user liked each post
    let postsWithLikes = posts;
    if (userId) {
      const userLikedPosts = await Post.find({
        _id: { $in: posts.map((p) => p._id) },
        likes: new mongoose.Types.ObjectId(userId),
      })
        .select("_id")
        .lean();

      const likedPostIds = new Set(
        userLikedPosts.map((p) => p._id.toString())
      );

      postsWithLikes = posts.map((post) => ({
        ...post,
        isLiked: likedPostIds.has(post._id.toString()),
        likeCount: post.likes?.length || 0,
      }));
    } else {
      postsWithLikes = posts.map((post) => ({
        ...post,
        isLiked: false,
        likeCount: post.likes?.length || 0,
      }));
    }

    res.json({
      posts: postsWithLikes,
      totalCount,
      page: pageNum,
      pageSize: limit,
      hasMore: skip + limit < totalCount,
    });
  } catch (error) {
    console.error("Error fetching posts:", error);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

// Get single post by ID
router.get("/posts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const post = await Post.findById(id)
      .populate("authorUserId", "username email picture")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .lean();

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Increment view count
    await Post.findByIdAndUpdate(id, { $inc: { viewCount: 1 } });

    // Check if user liked
    let isLiked = false;
    if (userId) {
      const likedPost = await Post.findOne({
        _id: id,
        likes: new mongoose.Types.ObjectId(userId),
      });
      isLiked = !!likedPost;
    }

    res.json({
      post: {
        ...post,
        isLiked,
        likeCount: post.likes?.length || 0,
      },
    });
  } catch (error) {
    console.error("Error fetching post:", error);
    res.status(500).json({ error: "Failed to fetch post" });
  }
});

// Create post (requires authentication)
router.post("/posts", verifySession, async (req, res) => {
  try {
    const {
      communityId,
      subcategoryId,
      content,
      postType, // "patient" or "researcher"
      attachments = [],
      tags = [],
      conditions = [],
      isOfficial = false,
    } = req.body;

    const authorUserId = req.user._id;
    const authorRole = req.user.role;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }

    if (!postType || !["patient", "researcher"].includes(postType)) {
      return res
        .status(400)
        .json({ error: "postType must be 'patient' or 'researcher'" });
    }

    // Validate community if provided
    if (communityId) {
      const community = await Community.findById(communityId);
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }
    }

    // Validate subcategory if provided
    if (subcategoryId) {
      const subcategory = await Subcategory.findById(subcategoryId);
      if (!subcategory) {
        return res.status(404).json({ error: "Subcategory not found" });
      }
    }

    // Only researchers can mark posts as official
    const officialFlag = authorRole === "researcher" ? isOfficial : false;

    const post = await Post.create({
      communityId: communityId || null,
      subcategoryId: subcategoryId || null,
      authorUserId,
      authorRole,
      postType,
      content: content.trim(),
      attachments: attachments.filter((att) => att.url && att.type),
      tags: Array.isArray(tags) ? tags.slice(0, 10) : [],
      conditions: normalizeConditions(conditions),
      isOfficial: officialFlag,
    });

    const populatedPost = await Post.findById(post._id)
      .populate("authorUserId", "username email picture")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .lean();

    // Invalidate cache
    invalidateCache("posts:");

    res.status(201).json({
      ok: true,
      post: {
        ...populatedPost,
        isLiked: false,
        likeCount: 0,
      },
    });
  } catch (error) {
    console.error("Error creating post:", error);
    res.status(500).json({ error: "Failed to create post" });
  }
});

// Update post (only author can update)
router.put("/posts/:id", verifySession, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, attachments, tags, conditions, isOfficial } = req.body;
    const userId = req.user._id;
    const userRole = req.user.role;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if user is the author
    if (post.authorUserId.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Not authorized to update this post" });
    }

    // Update fields
    if (content !== undefined) {
      post.content = content.trim();
    }
    if (attachments !== undefined) {
      post.attachments = attachments.filter((att) => att.url && att.type);
    }
    if (tags !== undefined) {
      post.tags = Array.isArray(tags) ? tags.slice(0, 10) : [];
    }
    if (conditions !== undefined) {
      post.conditions = normalizeConditions(conditions);
    }
    if (isOfficial !== undefined && userRole === "researcher") {
      post.isOfficial = isOfficial;
    }

    await post.save();

    const updatedPost = await Post.findById(id)
      .populate("authorUserId", "username email picture")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .lean();

    // Invalidate cache
    invalidateCache("posts:");

    res.json({
      ok: true,
      post: {
        ...updatedPost,
        isLiked: post.likes?.includes(userId) || false,
        likeCount: post.likes?.length || 0,
      },
    });
  } catch (error) {
    console.error("Error updating post:", error);
    res.status(500).json({ error: "Failed to update post" });
  }
});

// Delete post (only author can delete)
router.delete("/posts/:id", verifySession, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Check if user is the author
    if (post.authorUserId.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Not authorized to delete this post" });
    }

    await Post.findByIdAndDelete(id);

    // Invalidate cache
    invalidateCache("posts:");

    res.json({ ok: true, message: "Post deleted successfully" });
  } catch (error) {
    console.error("Error deleting post:", error);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// Like/Unlike post
router.post("/posts/:id/like", verifySession, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user._id;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    const isLiked = post.likes.some(
      (likeId) => likeId.toString() === userId.toString()
    );

    if (isLiked) {
      // Unlike
      post.likes = post.likes.filter(
        (likeId) => likeId.toString() !== userId.toString()
      );
    } else {
      // Like
      post.likes.push(userId);
    }

    await post.save();

    res.json({
      ok: true,
      isLiked: !isLiked,
      likeCount: post.likes.length,
    });
  } catch (error) {
    console.error("Error toggling like:", error);
    res.status(500).json({ error: "Failed to toggle like" });
  }
});

export default router;

