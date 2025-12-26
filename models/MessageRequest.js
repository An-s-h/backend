import mongoose from "mongoose";

const messageRequestSchema = new mongoose.Schema(
  {
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    expertId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requesterRole: { type: String, enum: ["patient", "researcher"], required: true },
    expertRole: { type: String, enum: ["patient", "researcher"], required: true, default: "researcher" },
    message: { type: String, required: true },
    status: { 
      type: String, 
      enum: ["pending", "accepted", "rejected"], 
      default: "pending",
      index: true
    },
    respondedAt: { type: Date },
  },
  { timestamps: true }
);

// Index for quick lookup of requests between users
messageRequestSchema.index({ requesterId: 1, expertId: 1, status: 1 });
messageRequestSchema.index({ expertId: 1, status: 1 });

export const MessageRequest = mongoose.models.MessageRequest || mongoose.model("MessageRequest", messageRequestSchema);

