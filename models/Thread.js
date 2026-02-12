import mongoose from "mongoose";

const threadSchema = new mongoose.Schema(
  {
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "ForumCategory" },
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: "Community", index: true },
    subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Subcategory", index: true },
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["patient", "researcher"], required: true },
    title: { type: String, required: true },
    body: { type: String, default: "" }, // Optional: question-only posts supported
    tags: [{ type: String }], // MeSH terminology tags
    // Condition tags so broad topics can be narrowed to a specific disease
    conditions: [{ type: String }],
    upvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    downvotes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    viewCount: { type: Number, default: 0 },
    // When true, only users with role "researcher" can reply (creator's choice)
    onlyResearchersCanReply: { type: Boolean, default: false },
    // When true, this thread was created in Researcher Forums (not visible in Health Forums)
    isResearcherForum: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Virtual for vote score
threadSchema.virtual("voteScore").get(function () {
  return (this.upvotes?.length || 0) - (this.downvotes?.length || 0);
});

export const Thread = mongoose.models.Thread || mongoose.model("Thread", threadSchema);


