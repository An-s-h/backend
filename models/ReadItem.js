import mongoose from "mongoose";

const readItemSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },
    type: {
      type: String,
      enum: ["trial", "publication"],
      required: true,
      index: true,
    },
    itemId: {
      type: String,
      required: true,
      index: true,
    },
    // Store when it was first read
    readAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  { timestamps: true }
);

// Compound index for efficient lookups (userId + type + itemId)
readItemSchema.index({ userId: 1, type: 1, itemId: 1 }, { unique: true });

export const ReadItem =
  mongoose.models.ReadItem || mongoose.model("ReadItem", readItemSchema);
