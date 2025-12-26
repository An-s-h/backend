import mongoose from "mongoose";

const threadSchema = new mongoose.Schema(
  {
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ForumCategory", required: true },
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["patient", "researcher"], required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    downvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    viewCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Virtual for vote score
threadSchema.virtual("voteScore").get(function () {
  return (this.upvotes?.length || 0) - (this.downvotes?.length || 0);
});

export const Thread = mongoose.models.Thread || mongoose.model("Thread", threadSchema);


