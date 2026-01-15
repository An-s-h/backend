import mongoose from "mongoose";

const communityMembershipSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: "Community", required: true, index: true },
    role: { type: String, enum: ["member", "moderator", "admin"], default: "member" },
    notifications: { type: Boolean, default: true }, // Receive notifications for this community
  },
  { timestamps: true }
);

// Ensure unique membership per user per community
communityMembershipSchema.index({ userId: 1, communityId: 1 }, { unique: true });

export const CommunityMembership = mongoose.models.CommunityMembership || mongoose.model("CommunityMembership", communityMembershipSchema);

