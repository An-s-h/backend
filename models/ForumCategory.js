import mongoose from "mongoose";

const forumCategorySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
  },
  { timestamps: true }
);

export const ForumCategory = mongoose.models.ForumCategory || mongoose.model("ForumCategory", forumCategorySchema);


