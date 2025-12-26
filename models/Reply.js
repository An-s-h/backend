import mongoose from "mongoose";

const replySchema = new mongoose.Schema(
  {
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: "Thread", required: true },
    parentReplyId: { type: mongoose.Schema.Types.ObjectId, ref: "Reply", default: null }, // For nested replies
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["patient", "researcher"], required: true },
    body: { type: String, required: true },
    upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    downvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

// Virtual for vote score
replySchema.virtual("voteScore").get(function () {
  return (this.upvotes?.length || 0) - (this.downvotes?.length || 0);
});

// Index for better query performance
replySchema.index({ threadId: 1, parentReplyId: 1 });

export const Reply = mongoose.models.Reply || mongoose.model("Reply", replySchema);


