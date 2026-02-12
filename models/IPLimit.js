import mongoose from "mongoose";

/**
 * Anonymous Limit Model - Browser-based tracking
 * Tracks search counts by browser deviceId (persistent identifier in localStorage)
 */
const ipLimitSchema = new mongoose.Schema(
  {
    // Primary: Browser-based device identifier (from localStorage)
    // This survives IP changes, proxy changes, and browser restarts
    deviceId: {
      type: String,
      required: true,
      unique: true,
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

// Device identifier index for search limit lookups
ipLimitSchema.index({ deviceId: 1 }, { unique: true });
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

