import { Router } from "express";
import mongoose from "mongoose";
import { Post } from "../models/Post.js";
import { Comment } from "../models/Comment.js";
import { User } from "../models/User.js";
import { Profile } from "../models/Profile.js";
import { Community } from "../models/Community.js";
import { Subcategory } from "../models/Subcategory.js";
import { CommunityMembership } from "../models/CommunityMembership.js";
import { verifySession } from "../middleware/auth.js";
import { enrichAuthorsWithDisplayName, getResearcherDisplayName } from "../utils/researcherDisplayName.js";

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
      linkedThreadId, // Check if thread is shared
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
    if (linkedThreadId) {
      query.linkedThreadId = new mongoose.Types.ObjectId(linkedThreadId);
    }

    // Get posts with pagination
    const posts = await Post.find(query)
      .populate("authorUserId", "username email picture role")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .populate("linkedThreadId", "title body categoryId")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Enrich researcher authors with displayName (Dr. Name, MD PHD)
    const authorIds = [...new Set(posts.map((p) => p.authorUserId?._id?.toString()).filter(Boolean))];
    const researcherIds = authorIds.filter((id) => {
      const author = posts.find((p) => p.authorUserId?._id?.toString() === id)?.authorUserId;
      return author?.role === "researcher";
    });
    if (researcherIds.length > 0) {
      const profiles = await Profile.find({ userId: { $in: researcherIds } }).lean();
      const profileMap = {};
      profiles.forEach((p) => {
        profileMap[p.userId.toString()] = p;
      });
      enrichAuthorsWithDisplayName(posts, profileMap);
    }

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
      .populate("authorUserId", "username email picture role")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .populate("linkedThreadId", "title body categoryId")
      .lean();

    if (post?.authorUserId?.role === "researcher") {
      const profile = await Profile.findOne({ userId: post.authorUserId._id }).lean();
      if (profile?.researcher) {
        post.authorUserId.displayName = getResearcherDisplayName(
          post.authorUserId.username || post.authorUserId.name,
          profile.researcher
        );
      }
    }

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
      linkedThreadId, // Link to forum thread if shared from forums
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

    // Role-based validation: patients can only post in patient posts, researchers can only post in researcher posts
    if (authorRole === "patient" && postType !== "patient") {
      return res.status(403).json({ 
        error: "Patients can only create posts in patient posts" 
      });
    }
    if (authorRole === "researcher" && postType !== "researcher") {
      return res.status(403).json({ 
        error: "Researchers can only create posts in researcher posts" 
      });
    }

    // Validate community if provided: must exist and user must be a member
    if (communityId) {
      const community = await Community.findById(communityId);
      if (!community) {
        return res.status(404).json({ error: "Community not found" });
      }
      const membership = await CommunityMembership.findOne({
        userId: authorUserId,
        communityId,
      });
      if (!membership) {
        return res.status(403).json({
          error: "You can only post to communities you have joined. Join this community from Forums first.",
        });
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

    // Validate linkedThreadId if provided
    if (linkedThreadId) {
      const { Thread } = await import("../models/Thread.js");
      const thread = await Thread.findById(linkedThreadId);
      if (!thread) {
        return res.status(404).json({ error: "Linked forum thread not found" });
      }
    }

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
      linkedThreadId: linkedThreadId || null,
    });

    const populatedPost = await Post.findById(post._id)
      .populate("authorUserId", "username email picture role")
      .populate("communityId", "name slug color icon")
      .populate("subcategoryId", "name slug")
      .lean();

    // Enrich researcher author with displayName (Dr. Name, credentials)
    if (populatedPost?.authorUserId?.role === "researcher") {
      const { Profile } = await import("../models/Profile.js");
      const profile = await Profile.findOne({
        userId: populatedPost.authorUserId._id,
      }).lean();
      if (profile?.researcher) {
        populatedPost.authorUserId.displayName = getResearcherDisplayName(
          populatedPost.authorUserId.username || populatedPost.authorUserId.name,
          profile.researcher
        );
      }
    }

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

// Get comments for a post
router.get("/posts/:id/comments", async (req, res) => {
  try {
    const { id } = req.params;
    const { userId } = req.query;

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // Get all comments for this post
    const comments = await Comment.find({ postId: id })
      .populate("authorUserId", "username email picture role")
      .sort({ createdAt: 1 })
      .lean();

    // Enrich researcher comment authors with displayName
    const commentAuthorIds = [...new Set(comments.map((c) => c.authorUserId?._id?.toString()).filter(Boolean))];
    const researcherCommentIds = commentAuthorIds.filter((id) => {
      const author = comments.find((c) => c.authorUserId?._id?.toString() === id)?.authorUserId;
      return author?.role === "researcher";
    });
    if (researcherCommentIds.length > 0) {
      const profiles = await Profile.find({ userId: { $in: researcherCommentIds } }).lean();
      const profileMap = {};
      profiles.forEach((p) => {
        profileMap[p.userId.toString()] = p;
      });
      enrichAuthorsWithDisplayName(comments, profileMap);
    }

    // Build comment tree (handle nested comments)
    const buildCommentTree = (parentId = null) => {
      return comments
        .filter((comment) => {
          const parent = comment.parentCommentId
            ? comment.parentCommentId.toString()
            : null;
          return parent === parentId;
        })
        .map((comment) => {
          const isLiked = userId
            ? comment.likes?.some(
                (likeId) => likeId.toString() === userId.toString()
              )
            : false;

          return {
            ...comment,
            isLiked,
            likeCount: comment.likes?.length || 0,
            children: buildCommentTree(comment._id.toString()),
          };
        });
    };

    const commentTree = buildCommentTree();

    res.json({
      ok: true,
      comments: commentTree,
      commentCount: comments.length,
    });
  } catch (error) {
    console.error("Error fetching comments:", error);
    res.status(500).json({ error: "Failed to fetch comments" });
  }
});

// Create comment on a post
router.post("/posts/:id/comments", verifySession, async (req, res) => {
  try {
    const { id } = req.params;
    const { content, parentCommentId } = req.body;
    const authorUserId = req.user._id;
    const authorRole = req.user.role;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: "Content is required" });
    }

    const post = await Post.findById(id);
    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    // If replying to another comment, check if it exists
    if (parentCommentId) {
      const parentComment = await Comment.findById(parentCommentId);
      if (!parentComment) {
        return res.status(404).json({ error: "Parent comment not found" });
      }
    }

    // Create comment
    const comment = await Comment.create({
      postId: id,
      parentCommentId: parentCommentId || null,
      authorUserId,
      authorRole,
      content: content.trim(),
    });

    // Update post reply count
    await Post.findByIdAndUpdate(id, { $inc: { replyCount: 1 } });

    // Populate comment with author info
    const populatedComment = await Comment.findById(comment._id)
      .populate("authorUserId", "username email picture role")
      .lean();

    if (populatedComment?.authorUserId?.role === "researcher") {
      const profile = await Profile.findOne({ userId: populatedComment.authorUserId._id }).lean();
      if (profile?.researcher) {
        populatedComment.authorUserId.displayName = getResearcherDisplayName(
          populatedComment.authorUserId.username || populatedComment.authorUserId.name,
          profile.researcher
        );
      }
    }

    // Invalidate cache
    invalidateCache("posts:");

    res.status(201).json({
      ok: true,
      comment: {
        ...populatedComment,
        isLiked: false,
        likeCount: 0,
        children: [],
      },
    });
  } catch (error) {
    console.error("Error creating comment:", error);
    res.status(500).json({ error: "Failed to create comment" });
  }
});

// Like/Unlike comment
router.post("/posts/:postId/comments/:commentId/like", verifySession, async (req, res) => {
  try {
    const { commentId } = req.params;
    const userId = req.user._id;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    const isLiked = comment.likes.some(
      (likeId) => likeId.toString() === userId.toString()
    );

    if (isLiked) {
      // Unlike
      comment.likes = comment.likes.filter(
        (likeId) => likeId.toString() !== userId.toString()
      );
    } else {
      // Like
      comment.likes.push(userId);
    }

    await comment.save();

    res.json({
      ok: true,
      isLiked: !isLiked,
      likeCount: comment.likes.length,
    });
  } catch (error) {
    console.error("Error toggling comment like:", error);
    res.status(500).json({ error: "Failed to toggle comment like" });
  }
});

// Delete comment (only author can delete)
router.delete("/posts/:postId/comments/:commentId", verifySession, async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user._id;

    const comment = await Comment.findById(commentId);
    if (!comment) {
      return res.status(404).json({ error: "Comment not found" });
    }

    // Check if user is the author
    if (comment.authorUserId.toString() !== userId.toString()) {
      return res.status(403).json({ error: "Not authorized to delete this comment" });
    }

    // Count child comments before deleting
    const childCount = await Comment.countDocuments({ parentCommentId: commentId });

    // Delete the comment and all its children
    await Comment.deleteMany({
      $or: [
        { _id: commentId },
        { parentCommentId: commentId }
      ]
    });

    // Update post reply count
    await Post.findByIdAndUpdate(postId, { $inc: { replyCount: -(1 + childCount) } });

    // Invalidate cache
    invalidateCache("posts:");

    res.json({ ok: true, message: "Comment deleted successfully" });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ error: "Failed to delete comment" });
  }
});

export default router;

