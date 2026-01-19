import mongoose from "mongoose";

const subcategorySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    parentCommunityId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Community",
      required: true,
      index: true,
    },
    tags: [{ type: String }], // MeSH terminology tags for recommendations
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isOfficial: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Compound index to ensure uniqueness within a community
subcategorySchema.index({ parentCommunityId: 1, slug: 1 }, { unique: true });
subcategorySchema.index({ name: "text", description: "text", tags: "text" });

export const Subcategory =
  mongoose.models.Subcategory ||
  mongoose.model("Subcategory", subcategorySchema);
