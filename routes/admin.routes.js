import { Router } from "express";
import { Profile } from "../models/Profile.js";
import { User } from "../models/User.js";
import { DeviceToken } from "../models/DeviceToken.js";
import { IPLimit } from "../models/IPLimit.js";

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

// Reset all device token search counts (for testing)
router.post(
  "/admin/search/reset-device-tokens",
  verifyAdmin,
  async (req, res) => {
    try {
      const result = await DeviceToken.updateMany(
        {},
        { $set: { searchCount: 0, lastSearchAt: null } }
      );

      res.json({
        success: true,
        message: `Reset search counts for ${result.modifiedCount} device tokens`,
        modifiedCount: result.modifiedCount,
      });
    } catch (error) {
      console.error("Error resetting device token search counts:", error);
      res
        .status(500)
        .json({ error: "Failed to reset device token search counts" });
    }
  }
);

// Reset all IP search counts (for testing)
router.post("/admin/search/reset-ip-limits", verifyAdmin, async (req, res) => {
  try {
    const result = await IPLimit.updateMany(
      {},
      { $set: { searchCount: 0, lastSearchAt: null } }
    );

    res.json({
      success: true,
      message: `Reset search counts for ${result.modifiedCount} IP addresses`,
      modifiedCount: result.modifiedCount,
    });
  } catch (error) {
    console.error("Error resetting IP search counts:", error);
    res.status(500).json({ error: "Failed to reset IP search counts" });
  }
});

// Reset all search limits (device tokens + IPs) - convenient for testing
router.post("/admin/search/reset-all", verifyAdmin, async (req, res) => {
  try {
    const [deviceResult, ipResult] = await Promise.all([
      DeviceToken.updateMany(
        {},
        { $set: { searchCount: 0, lastSearchAt: null } }
      ),
      IPLimit.updateMany({}, { $set: { searchCount: 0, lastSearchAt: null } }),
    ]);

    res.json({
      success: true,
      message: "Reset all search limits successfully",
      deviceTokensReset: deviceResult.modifiedCount,
      ipLimitsReset: ipResult.modifiedCount,
    });
  } catch (error) {
    console.error("Error resetting all search limits:", error);
    res.status(500).json({ error: "Failed to reset search limits" });
  }
});

// Cleanup old unused device tokens (for maintenance)
router.post(
  "/admin/search/cleanup-device-tokens",
  verifyAdmin,
  async (req, res) => {
    try {
      // Delete tokens that haven't been used in 30+ days OR were created 7+ days ago and never used
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const result = await DeviceToken.deleteMany({
        $or: [
          // Tokens that haven't been used in 30+ days
          { lastSearchAt: { $lt: thirtyDaysAgo } },
          // Tokens created 7+ days ago that were never used
          {
            createdAt: { $lt: sevenDaysAgo },
            lastSearchAt: { $exists: false },
          },
        ],
      });

      res.json({
        success: true,
        message: `Cleaned up ${result.deletedCount} old device tokens`,
        deletedCount: result.deletedCount,
      });
    } catch (error) {
      console.error("Error cleaning up device tokens:", error);
      res.status(500).json({ error: "Failed to cleanup device tokens" });
    }
  }
);

// Get current search limit configuration
router.get("/admin/search/config", verifyAdmin, async (req, res) => {
  try {
    const MAX_FREE_SEARCHES = parseInt(
      process.env.MAX_FREE_SEARCHES || "6",
      10
    );

    // Get statistics
    const [
      deviceTokenCount,
      ipLimitCount,
      totalDeviceSearches,
      totalIPSearches,
    ] = await Promise.all([
      DeviceToken.countDocuments({}),
      IPLimit.countDocuments({}),
      DeviceToken.aggregate([
        { $group: { _id: null, total: { $sum: "$searchCount" } } },
      ]),
      IPLimit.aggregate([
        { $group: { _id: null, total: { $sum: "$searchCount" } } },
      ]),
    ]);

    res.json({
      maxFreeSearches: MAX_FREE_SEARCHES,
      statistics: {
        deviceTokens: {
          total: deviceTokenCount,
          totalSearches: totalDeviceSearches[0]?.total || 0,
        },
        ipLimits: {
          total: ipLimitCount,
          totalSearches: totalIPSearches[0]?.total || 0,
        },
      },
    });
  } catch (error) {
    console.error("Error getting search config:", error);
    res.status(500).json({ error: "Failed to get search configuration" });
  }
});

export default router;
