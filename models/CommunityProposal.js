import mongoose from "mongoose";

const communityProposalSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    thumbnailUrl: { type: String, default: "" },
    proposedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    proposedByRole: { type: String, enum: ["patient", "researcher"], default: "patient" },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    reviewedAt: { type: Date },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    createdCommunityId: { type: mongoose.Schema.Types.ObjectId, ref: "Community" },
  },
  { timestamps: true }
);

communityProposalSchema.index({ status: 1, createdAt: -1 });

export const CommunityProposal =
  mongoose.models.CommunityProposal ||
  mongoose.model("CommunityProposal", communityProposalSchema);
