import { Router } from "express";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { SearchLimit } from "../models/SearchLimit.js";

const router = Router();

// Admin credentials (hardcoded for basic implementation)
const ADMIN_USERNAME = "admin123";
const ADMIN_PASSWORD = "admin123";

// Admin login endpoint
router.post("/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      // Set a simple session token (in production, use JWT or proper session management)
      res.json({
        success: true,
        message: "Login successful",
        token: "admin_token_123", // Simple token for basic implementation
      });
    } else {
      res.status(401).json({
        success: false,
        error: "Invalid credentials",
      });
    }
  } catch (error) {
    console.error("Admin login error:", error);
    res.status(500).json({ error: "Failed to login" });
  }
});

// Middleware to verify admin token (basic implementation)
const verifyAdmin = (req, res, next) => {
  const token =
    req.headers.authorization?.replace("Bearer ", "") || req.query.token;

  if (token === "admin_token_123") {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized. Admin access required." });
  }
};

// Get all CuraLink experts (for admin dashboard)
router.get("/admin/experts", verifyAdmin, async (req, res) => {
  try {
    const profiles = await Profile.find({ role: "researcher" })
      .populate("userId", "username email")
      .lean();

    const experts = profiles
      .filter((p) => p.userId && p.researcher)
      .map((profile) => {
        const user = profile.userId;
        const researcher = profile.researcher || {};
        return {
          _id: profile.userId._id || profile.userId.id,
          userId: profile.userId._id || profile.userId.id,
          name: user.username || "Unknown Researcher",
          email: user.email,
          orcid: researcher.orcid || null,
          bio: researcher.bio || null,
          location: researcher.location || null,
          specialties: researcher.specialties || [],
          interests: researcher.interests || [],
          available: researcher.available || false,
          isVerified: researcher.isVerified || false,
        };
      });

    res.json({ experts });
  } catch (error) {
    console.error("Error fetching experts for admin:", error);
    res.status(500).json({ error: "Failed to fetch experts" });
  }
});

// Update expert verification status
router.patch("/admin/experts/:userId/verify", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const { isVerified } = req.body;

    if (typeof isVerified !== "boolean") {
      return res.status(400).json({ error: "isVerified must be a boolean" });
    }

    const profile = await Profile.findOne({ userId });
    if (!profile || profile.role !== "researcher") {
      return res.status(404).json({ error: "Expert not found" });
    }

    // Update the isVerified field in the researcher subdocument
    profile.researcher.isVerified = isVerified;
    await profile.save();

    res.json({
      success: true,
      message: `Expert ${isVerified ? "verified" : "unverified"} successfully`,
      expert: {
        userId: profile.userId._id || profile.userId.id,
        isVerified: profile.researcher.isVerified,
      },
    });
  } catch (error) {
    console.error("Error updating expert verification:", error);
    res.status(500).json({ error: "Failed to update verification status" });
  }
});

// ============================================
// SEARCH LIMIT MANAGEMENT ENDPOINTS (FOR TESTING)
// ============================================

// Reset all search limits (token-based)
router.post("/admin/search/reset-all", verifyAdmin, async (req, res) => {
  try {
    const result = await SearchLimit.updateMany(
      {},
      { $set: { searchCount: 0, lastSearchAt: null } }
    );

    res.json({
      success: true,
      message: "Reset all search limits successfully",
      recordsReset: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error resetting search limits:", error);
    res.status(500).json({ error: "Failed to reset search limits" });
  }
});

// Get current search limit configuration
router.get("/admin/search/config", verifyAdmin, async (req, res) => {
  try {
    const MAX_FREE_SEARCHES = parseInt(
      process.env.MAX_FREE_SEARCHES || "6",
      10
    );

    // Get statistics
    const [tokenCount, totalSearches] = await Promise.all([
      SearchLimit.countDocuments({}),
      SearchLimit.aggregate([
        { $group: { _id: null, total: { $sum: "$searchCount" } } },
      ]),
    ]);

    res.json({
      maxFreeSearches: MAX_FREE_SEARCHES,
      statistics: {
        anonymousTokens: {
          total: tokenCount,
          totalSearches: totalSearches[0]?.total || 0,
        },
      },
    });
  } catch (error) {
    console.error("Error getting search config:", error);
    res.status(500).json({ error: "Failed to get search configuration" });
  }
});

// Reset verification email limit for a user (admin only)
router.post("/admin/users/:userId/reset-verification-email-limit", verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    // Reset the lastVerificationEmailSent timestamp
    user.lastVerificationEmailSent = undefined;
    await user.save();

    return res.json({
      success: true,
      message: `Verification email limit reset for user ${user.email || userId}`,
      user: {
        userId: user._id.toString(),
        email: user.email,
        username: user.username,
      },
    });
  } catch (error) {
    console.error("Error resetting verification email limit:", error);
    res.status(500).json({ error: "Failed to reset verification email limit" });
  }
});

export default router;
