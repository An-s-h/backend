import { Router } from "express";
import { Feedback } from "../models/Feedback.js";
import { User } from "../models/User.js";

const router = Router();

// Submit feedback
router.post("/feedback", async (req, res) => {
  try {
    const {
      userId,
      rating,
      comment,
      pageUrl,

      // Structured survey fields from Collabiora feedback modal
      role,
      purposes,
      experience,
      found,
      mostValuable,
      confusing,
      returnLikelihood,
      improvement,
      whatMatters,
    } = req.body;

    if (!userId || !rating) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get user info
    const user = await User.findById(userId).lean();
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const feedback = await Feedback.create({
      userId,
      userRole: user.role || "patient",
      username: user.username || "Unknown",
      email: user.email,
      rating,
      // Prefer explicit improvement text if provided; fall back to raw comment
      comment: improvement || comment || "",
      pageUrl: pageUrl || req.headers.referer || "Unknown",
      userAgent: req.headers["user-agent"] || "Unknown",

      // Persist structured survey data separately for admin analytics
      surveyRole: role || null,
      surveyPurposes: Array.isArray(purposes) ? purposes : [],
      surveyExperience: experience || null,
      surveyFound: found || null,
      surveyMostValuable: Array.isArray(mostValuable) ? mostValuable : [],
      surveyConfusing: Array.isArray(confusing) ? confusing : [],
      surveyReturnLikelihood:
        typeof returnLikelihood === "number"
          ? returnLikelihood
          : returnLikelihood != null
            ? Number(returnLikelihood)
            : null,
      surveyImprovement: improvement || "",
      surveyWhatMatters: Array.isArray(whatMatters) ? whatMatters : [],
    });

    res.json({ ok: true, feedback });
  } catch (error) {
    console.error("Error submitting feedback:", error);
    res.status(500).json({ error: "Failed to submit feedback" });
  }
});

// Get all feedback (for admin)
router.get("/feedback", async (req, res) => {
  try {
    const { limit = 50, offset = 0, sort = "desc" } = req.query;

    const sortOrder = sort === "asc" ? 1 : -1;

    const feedbacks = await Feedback.find({})
      .populate("userId", "username email role")
      .sort({ createdAt: sortOrder })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await Feedback.countDocuments({});

    res.json({
      feedbacks,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error("Error fetching feedback:", error);
    res.status(500).json({ error: "Failed to fetch feedback" });
  }
});

// Get feedback stats (for admin)
router.get("/feedback/stats", async (req, res) => {
  try {
    const total = await Feedback.countDocuments({});
    const excellent = await Feedback.countDocuments({ rating: "excellent" });
    const good = await Feedback.countDocuments({ rating: "good" });
    const average = await Feedback.countDocuments({ rating: "average" });
    const poor = await Feedback.countDocuments({ rating: "poor" });

    const byRole = {
      patient: await Feedback.countDocuments({ userRole: "patient" }),
      researcher: await Feedback.countDocuments({ userRole: "researcher" }),
    };

    res.json({
      total,
      ratings: { excellent, good, average, poor },
      byRole,
    });
  } catch (error) {
    console.error("Error fetching feedback stats:", error);
    res.status(500).json({ error: "Failed to fetch feedback stats" });
  }
});

// Check if a user has already submitted any feedback
router.get("/feedback/has-submitted/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      return res.status(400).json({ error: "Missing userId" });
    }

    const count = await Feedback.countDocuments({ userId });
    res.json({ hasSubmitted: count > 0 });
  } catch (error) {
    console.error("Error checking feedback submission:", error);
    res.status(500).json({ error: "Failed to check feedback submission" });
  }
});

export default router;
