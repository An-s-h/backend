import mongoose from "mongoose";

const deviceTokenSchema = new mongoose.Schema(
  {
    token: {
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
deviceTokenSchema.index({ token: 1 });
deviceTokenSchema.index({ createdAt: 1 });

// TTL index to automatically delete old unused tokens after 30 days
// This prevents database bloat from abandoned tokens
deviceTokenSchema.index(
  { lastSearchAt: 1 },
  {
    expireAfterSeconds: 30 * 24 * 60 * 60, // 30 days
    partialFilterExpression: { lastSearchAt: { $exists: true } }, // Only apply to tokens that have been used
  }
);

// Also delete tokens that were created but never used after 7 days
deviceTokenSchema.index(
  { createdAt: 1 },
  {
    expireAfterSeconds: 7 * 24 * 60 * 60, // 7 days
    partialFilterExpression: { lastSearchAt: { $exists: false } }, // Only apply to tokens that were never used
  }
);

export const DeviceToken =
  mongoose.models.DeviceToken ||
  mongoose.model("DeviceToken", deviceTokenSchema);
