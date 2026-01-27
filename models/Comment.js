import mongoose from "mongoose";

const commentSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    parentCommentId: { type: mongoose.Schema.Types.ObjectId, ref: "Comment", default: null }, // For nested comments
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["patient", "researcher"], required: true },
    content: { type: String, required: true },
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
  },
  { timestamps: true }
);

// Virtual for like count
commentSchema.virtual("likeCount").get(function () {
  return this.likes?.length || 0;
});

// Ensure virtuals are included in JSON output
commentSchema.set("toJSON", { virtuals: true });
commentSchema.set("toObject", { virtuals: true });

// Index for better query performance
commentSchema.index({ postId: 1, parentCommentId: 1 });
commentSchema.index({ createdAt: -1 });

export const Comment = mongoose.models.Comment || mongoose.model("Comment", commentSchema);

