import { Router } from "express";
import { Notification } from "../models/Notification.js";
import { Follow } from "../models/Follow.js";
import { Message } from "../models/Message.js";
import { Reply } from "../models/Reply.js";
import { Thread } from "../models/Thread.js";
import { Trial } from "../models/Trial.js";
import { Profile } from "../models/Profile.js";
import { Favorite } from "../models/Favorite.js";

const router = Router();

// Get all insights/notifications for a user
router.get("/insights/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50, offset = 0 } = req.query;

    const notifications = await Notification.find({ userId })
      .populate("relatedUserId", "username email")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const unreadCount = await Notification.countDocuments({ userId, read: false });

    const profile = await Profile.findOne({ userId }).lean();
    const userRole = profile?.role;

    let metrics = {};
    
    if (userRole === "patient") {
      const threads = await Thread.find({ authorUserId: userId }).lean();
      const replies = await Reply.find({ authorUserId: userId }).lean();
      
      const threadUpvotes = threads.reduce((sum, t) => sum + (t.upvotes?.length || 0), 0);
      const replyUpvotes = replies.reduce((sum, r) => sum + (r.upvotes?.length || 0), 0);
      
      metrics = {
        threadsCreated: threads.length,
        repliesCreated: replies.length,
        totalUpvotes: threadUpvotes + replyUpvotes,
        threadViews: threads.reduce((sum, t) => sum + (t.viewCount || 0), 0),
      };
    } else if (userRole === "researcher") {
      const threads = await Thread.find({ authorUserId: userId }).lean();
      const replies = await Reply.find({ authorUserId: userId }).lean();
      const trials = await Trial.find({ ownerResearcherId: userId }).lean();
      
      const followerCount = await Follow.countDocuments({ followingId: userId });
      const threadUpvotes = threads.reduce((sum, t) => sum + (t.upvotes?.length || 0), 0);
      const replyUpvotes = replies.reduce((sum, r) => sum + (r.upvotes?.length || 0), 0);
      
      const trialIds = trials.map(t => t._id.toString());
      const trialFavorites = await Favorite.countDocuments({
        type: "trial",
        "item.id": { $in: trialIds },
      });
      
      metrics = {
        followers: followerCount,
        threadsCreated: threads.length,
        repliesCreated: replies.length,
        trialsCreated: trials.length,
        totalUpvotes: threadUpvotes + replyUpvotes,
        threadViews: threads.reduce((sum, t) => sum + (t.viewCount || 0), 0),
        trialFavorites: trialFavorites,
      };
    }

    res.json({
      notifications,
      unreadCount,
      metrics,
    });
  } catch (error) {
    console.error("Error fetching insights:", error);
    res.status(500).json({ error: "Failed to fetch insights" });
  }
});

// Mark notification as read
router.patch("/insights/:notificationId/read", async (req, res) => {
  try {
    const { notificationId } = req.params;
    await Notification.findByIdAndUpdate(notificationId, { read: true });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error marking notification as read:", error);
    res.status(500).json({ error: "Failed to mark notification as read" });
  }
});

// Mark all notifications as read
router.patch("/insights/:userId/read-all", async (req, res) => {
  try {
    const { userId } = req.params;
    await Notification.updateMany({ userId, read: false }, { read: true });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error marking all as read:", error);
    res.status(500).json({ error: "Failed to mark all as read" });
  }
});

// Get followers for a researcher
router.get("/insights/:userId/followers", async (req, res) => {
  try {
    const { userId } = req.params;
    const followers = await Follow.find({ followingId: userId })
      .populate("followerId", "username email")
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      followers: followers.map(f => ({
        _id: f.followerId._id || f.followerId.id,
        username: f.followerId.username,
        email: f.followerId.email,
        followedAt: f.createdAt,
      })),
      count: followers.length,
    });
  } catch (error) {
    console.error("Error fetching followers:", error);
    res.status(500).json({ error: "Failed to fetch followers" });
  }
});

// Get following list
router.get("/insights/:userId/following", async (req, res) => {
  try {
    const { userId } = req.params;
    const following = await Follow.find({ followerId: userId })
      .populate("followingId", "username email picture role")
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({
      following: following.map(f => ({
        _id: f.followingId._id || f.followingId.id,
        username: f.followingId.username,
        email: f.followingId.email,
        picture: f.followingId.picture,
        role: f.followingId.role,
        followedAt: f.createdAt,
      })),
      count: following.length,
    });
  } catch (error) {
    console.error("Error fetching following:", error);
    res.status(500).json({ error: "Failed to fetch following" });
  }
});

// Check if user is following another user
router.get("/insights/:followerId/following/:followingId", async (req, res) => {
  try {
    const { followerId, followingId } = req.params;
    const follow = await Follow.findOne({ followerId, followingId });
    res.json({ isFollowing: !!follow });
  } catch (error) {
    console.error("Error checking follow status:", error);
    res.status(500).json({ error: "Failed to check follow status" });
  }
});

export default router;

