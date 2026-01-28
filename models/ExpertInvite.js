import mongoose from "mongoose";

const expertInviteSchema = new mongoose.Schema(
  {
    inviterId: { 
      type: mongoose.Schema.Types.ObjectId, 
      ref: "User", 
      required: true, 
      index: true 
    },
    expertName: { 
      type: String, 
      required: true, 
      index: true 
    },
    expertOrcid: { 
      type: String, 
      default: null, 
      index: true 
    },
    expertAffiliation: { 
      type: String, 
      default: null 
    },
    expertLocation: { 
      type: String, 
      default: null 
    },
    status: { 
      type: String, 
      enum: ["pending", "sent", "accepted", "rejected"], 
      default: "pending",
      index: true
    },
    invitedAt: { 
      type: Date, 
      default: Date.now 
    },
  },
  { timestamps: true }
);

// Ensure unique invite per user-expert combination
// Use name + orcid (if available) as unique identifier
expertInviteSchema.index({ inviterId: 1, expertName: 1, expertOrcid: 1 }, { unique: true });
expertInviteSchema.index({ expertName: 1, expertOrcid: 1 });

export const ExpertInvite = mongoose.models.ExpertInvite || mongoose.model("ExpertInvite", expertInviteSchema);

