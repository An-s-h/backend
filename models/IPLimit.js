import mongoose from "mongoose";

const ipLimitSchema = new mongoose.Schema(
  {
    hashedIP: {
      type: String,
      required: true,
      unique: true,
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

// Index for efficient lookups
ipLimitSchema.index({ hashedIP: 1 });
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

