import mongoose from "mongoose";

const followSchema = new mongoose.Schema(
  {
    followerId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    followingId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    followerRole: { type: String, enum: ["patient", "researcher"], required: true },
    followingRole: { type: String, enum: ["patient", "researcher"], required: true },
  },
  { timestamps: true }
);

// Ensure unique follow relationship
followSchema.index({ followerId: 1, followingId: 1 }, { unique: true });

export const Follow = mongoose.models.Follow || mongoose.model("Follow", followSchema);

