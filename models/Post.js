import mongoose from "mongoose";

const postSchema = new mongoose.Schema(
  {
    communityId: { type: mongoose.Schema.Types.ObjectId, ref: "Community", index: true },
    subcategoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Subcategory", index: true },
    authorUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    authorRole: { type: String, enum: ["patient", "researcher"], required: true },
    postType: { type: String, enum: ["patient", "researcher"], required: true }, // Type of post (not author role)
    content: { type: String, required: true },
    attachments: [{ 
      type: { type: String, enum: ["image", "file"], required: true },
      url: { type: String, required: true },
      name: { type: String },
      size: { type: Number }, // Size in bytes
    }],
    tags: [{ type: String }], // MeSH terminology tags
    conditions: [{ type: String }], // Condition tags
    isOfficial: { type: Boolean, default: false }, // Official work flag for researchers
    linkedThreadId: { type: mongoose.Schema.Types.ObjectId, ref: "Thread", index: true }, // Link to forum thread if shared from forums
    likes: [{ type: mongoose.Schema.Types.ObjectId, ref: "User" }],
    viewCount: { type: Number, default: 0 },
    // For replies/comments on posts
    replyCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Virtual for like count
postSchema.virtual("likeCount").get(function () {
  return this.likes?.length || 0;
});

// Ensure virtuals are included in JSON output
postSchema.set("toJSON", { virtuals: true });
postSchema.set("toObject", { virtuals: true });

// Indexes for better query performance
postSchema.index({ postType: 1, createdAt: -1 });
postSchema.index({ communityId: 1, createdAt: -1 });
postSchema.index({ authorUserId: 1, createdAt: -1 });
postSchema.index({ authorRole: 1, createdAt: -1 });

export const Post = mongoose.models.Post || mongoose.model("Post", postSchema);

