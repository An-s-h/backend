import mongoose from "mongoose";

/**
 * Anonymous Limit Model - Browser-based tracking
 * Tracks search counts by browser deviceId (persistent identifier in localStorage)
 * Falls back to hashedIP for backward compatibility
 */
const ipLimitSchema = new mongoose.Schema(
  {
    // Primary: Browser-based device identifier (from localStorage)
    // This survives IP changes, proxy changes, and browser restarts
    deviceId: {
      type: String,
      required: false, // Not required for backward compatibility
      unique: true,
      sparse: true, // Allows null/undefined values
      index: true,
    },
    // Fallback: Hashed IP address (for backward compatibility and legacy records)
    hashedIP: {
      type: String,
      required: false, // Not required anymore (deviceId is primary)
      unique: true,
      sparse: true, // Allows null/undefined values
      index: true,
    },
    searchCount: {
      type: Number,
      default: 0,
    },
    lastSearchAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index: prefer deviceId, fallback to hashedIP
ipLimitSchema.index({ deviceId: 1 }, { sparse: true });
ipLimitSchema.index({ hashedIP: 1 }, { sparse: true });
ipLimitSchema.index({ createdAt: 1 });

// TTL index to automatically delete old records after 30 days
// This helps with privacy and keeps the database clean
// Documents will be deleted 30 days after lastSearchAt
ipLimitSchema.index(
  { lastSearchAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);

export const IPLimit =
  mongoose.models.IPLimit || mongoose.model("IPLimit", ipLimitSchema);

