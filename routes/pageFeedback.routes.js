import { Router } from "express";
import { PageFeedback } from "../models/PageFeedback.js";
import { User } from "../models/User.js";

const router = Router();

<<<<<<< HEAD
// Submit page feedback (supports both signed-in and anonymous users)
router.post("/page-feedback", async (req, res) => {
  try {
    const { userId, feedback, pagePath, pageUrl } = req.body;

    if (!feedback || !pagePath) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    let username = "Anonymous";
    let email = null;
    let userRole = "guest";
    let resolvedUserId = null;

    if (userId) {
      const user = await User.findById(userId).lean();
      if (user) {
        resolvedUserId = userId;
        username = user.username || "Unknown";
        email = user.email;
        userRole = user.role || "patient";
      }
    }

    const pageFeedback = await PageFeedback.create({
      userId: resolvedUserId,
      username,
      email,
      userRole,
=======
// Submit page feedback
router.post("/page-feedback", async (req, res) => {
  try {
    const {
      userId,
      feedback,
      pagePath,
      pageUrl,
    } = req.body;

    if (!userId || !feedback || !pagePath) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get user info
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const pageFeedback = await PageFeedback.create({
      userId,
      username: user.username || "Unknown",
      email: user.email,
      userRole: user.role || "patient",
>>>>>>> 3f8e8205a7aa54c4ad53b79b7152ff87798de62d
      feedback: feedback.trim(),
      pagePath,
      pageUrl: pageUrl || req.headers.referer || "Unknown",
      userAgent: req.headers["user-agent"] || "Unknown",
    });

    res.json({ ok: true, feedback: pageFeedback });
  } catch (error) {
    console.error("Error submitting page feedback:", error);
    res.status(500).json({ error: "Failed to submit page feedback" });
  }
});

// Get all page feedback (for admin)
router.get("/page-feedback", async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = "desc", pagePath } = req.query;

    const sortOrder = sort === "asc" ? 1 : -1;
    const query = pagePath ? { pagePath } : {};

    const feedbacks = await PageFeedback.find(query)
      .populate("userId", "username email role")
      .sort({ createdAt: sortOrder })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await PageFeedback.countDocuments(query);

    res.json({
      feedbacks,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error("Error fetching page feedback:", error);
    res.status(500).json({ error: "Failed to fetch page feedback" });
  }
});

// Get page feedback stats (for admin)
router.get("/page-feedback/stats", async (req, res) => {
  try {
    const total = await PageFeedback.countDocuments({});

    // Get feedback count by page
    const byPage = await PageFeedback.aggregate([
      {
        $group: {
          _id: "$pagePath",
          count: { $sum: 1 },
        },
      },
      {
        $sort: { count: -1 },
      },
    ]);

    const byRole = {
      patient: await PageFeedback.countDocuments({ userRole: "patient" }),
      researcher: await PageFeedback.countDocuments({ userRole: "researcher" }),
<<<<<<< HEAD
      guest: await PageFeedback.countDocuments({ userRole: "guest" }),
=======
>>>>>>> 3f8e8205a7aa54c4ad53b79b7152ff87798de62d
    };

    res.json({
      total,
      byPage,
      byRole,
    });
  } catch (error) {
    console.error("Error fetching page feedback stats:", error);
    res.status(500).json({ error: "Failed to fetch page feedback stats" });
  }
});

export default router;
