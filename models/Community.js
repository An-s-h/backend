import mongoose from "mongoose";

const communitySchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    description: { type: String, default: "" },
    icon: { type: String, default: "💬" }, // Emoji or icon identifier (legacy)
    iconSvg: { type: String, default: "" }, // SVG code for custom icon (used on Health Forums)
    color: { type: String, default: "#2F3C96" }, // Brand color
    coverImage: { type: String, default: "" },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "CommunityCategory", default: null }, // For Health Forums grouped display
    tags: [{ type: String }], // MeSH terminology tags for recommendations
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    isOfficial: { type: Boolean, default: false }, // Official CuraLink communities
    isPrivate: { type: Boolean, default: false },
    communityType: { type: String, enum: ["patient", "researcher"], default: "patient" },
    createdByResearcher: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Index for faster searching
communitySchema.index({ name: "text", description: "text", tags: "text" });

export const Community = mongoose.models.Community || mongoose.model("Community", communitySchema);

