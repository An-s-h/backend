import { Router } from "express";
import { Follow } from "../models/Follow.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

const router = Router();

// Follow a user
router.post("/follow", async (req, res) => {
  try {
    const { followerId, followingId, followerRole, followingRole } = req.body;

    if (!followerId || !followingId || !followerRole || !followingRole) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (followerId === followingId) {
      return res.status(400).json({ error: "Cannot follow yourself" });
    }

    const existing = await Follow.findOne({ followerId, followingId });
    if (existing) {
      return res.json({ ok: true, message: "Already following" });
    }

    const follow = await Follow.create({
      followerId,
      followingId,
      followerRole,
      followingRole,
    });

    // Create notification for the person being followed (researcher or patient)
    const follower = await User.findById(followerId).lean();
    await Notification.create({
      userId: followingId,
      type: "new_follower",
      relatedUserId: followerId,
      title: "New Follower",
      message: `${follower?.username || "Someone"} started following you`,
      metadata: {
        followerUsername: follower?.username,
        followerRole,
      },
    });

    res.json({ ok: true, follow });
  } catch (error) {
    console.error("Error creating follow:", error);
    if (error.code === 11000) {
      return res.json({ ok: true, message: "Already following" });
    }
    res.status(500).json({ error: "Failed to create follow relationship" });
  }
});

// Unfollow a user
router.delete("/follow", async (req, res) => {
  try {
    const { followerId, followingId } = req.body;

    if (!followerId || !followingId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    await Follow.deleteOne({ followerId, followingId });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error unfollowing:", error);
    res.status(500).json({ error: "Failed to unfollow" });
  }
});

// Get list of user IDs that the given user follows (for feed sorting and +Follow UI)
router.get("/follow/following-ids", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const follows = await Follow.find({ followerId: userId })
      .select("followingId")
      .lean();

    const followingIds = follows.map((f) => f.followingId.toString());
    res.json({ followingIds });
  } catch (error) {
    console.error("Error fetching following IDs:", error);
    res.status(500).json({ error: "Failed to fetch following list" });
  }
});

export default router;

