import mongoose from "mongoose";

/**
 * Unified Search Limit Model
 * Tracks search counts across multiple identifier types
 * Uses a combination of fingerprint, deviceToken, and IP to prevent bypassing
 */
const searchLimitSchema = new mongoose.Schema(
  {
    // The identifier value (fingerprint hash, device token, or hashed IP)
    identifier: {
      type: String,
      required: true,
      index: true,
    },
    // Type of identifier
    identifierType: {
      type: String,
      enum: ["fingerprint", "deviceToken", "ip", "signalHash"],
      required: true,
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
    // Other identifiers linked to this one (for cross-referencing)
    linkedIdentifiers: [{
      type: String,
    }],
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

// Compound unique index on identifier + identifierType
searchLimitSchema.index({ identifier: 1, identifierType: 1 }, { unique: true });

// TTL index - auto-delete records after 30 days of inactivity
searchLimitSchema.index(
  { lastSearchAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);

// Index for finding linked records
searchLimitSchema.index({ linkedIdentifiers: 1 });

export const SearchLimit = mongoose.model("SearchLimit", searchLimitSchema);

