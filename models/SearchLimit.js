import mongoose from "mongoose";

/**
 * Search Limit Model - Token-based tracking
 * Tracks search counts by anonymous session token UUID only
 */
const searchLimitSchema = new mongoose.Schema(
  {
    // Anonymous session token UUID (primary identifier)
    tokenUuid: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    // Number of searches performed
    searchCount: {
      type: Number,
      default: 0,
    },
    // Last search timestamp
    lastSearchAt: {
      type: Date,
      default: null,
    },
    // First seen timestamp
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// TTL index - auto-delete records after 30 days of inactivity
searchLimitSchema.index(
  { lastSearchAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);

export const SearchLimit = mongoose.model("SearchLimit", searchLimitSchema);

