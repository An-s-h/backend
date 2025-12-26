import mongoose from "mongoose";

const favoriteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", index: true, required: true },
    type: { type: String, enum: ["trial", "publication", "expert", "collaborator", "thread"], required: true },
    item: { type: Object, required: true },
    addedByUrl: { type: Boolean, default: false }, // Flag to indicate if item was added via URL
  },
  { timestamps: true }
);

export const Favorite = mongoose.models.Favorite || mongoose.model("Favorite", favoriteSchema);


