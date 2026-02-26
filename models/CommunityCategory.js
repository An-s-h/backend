import mongoose from "mongoose";

const communityCategorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    sortOrder: { type: Number, default: 0 },
    defaultOpen: { type: Boolean, default: false },
    headingColor: { type: String, default: "#2F3C96" },
  },
  { timestamps: true }
);

export const CommunityCategory =
  mongoose.models.CommunityCategory ||
  mongoose.model("CommunityCategory", communityCategorySchema);
