import mongoose from "mongoose";

const connectionRequestSchema = new mongoose.Schema(
  {
    requesterId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    receiverId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, default: "" },
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

// Ensure unique connection request between two researchers
connectionRequestSchema.index({ requesterId: 1, receiverId: 1 }, { unique: true });
connectionRequestSchema.index({ receiverId: 1, status: 1 });

export const ConnectionRequest = mongoose.models.ConnectionRequest || mongoose.model("ConnectionRequest", connectionRequestSchema);

