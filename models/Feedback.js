import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    userRole: { type: String, enum: ["patient", "researcher"], required: true },
    username: { type: String, required: true },
    email: { type: String },
    rating: { type: String, required: true }, // "excellent", "good", "average", "poor"
    comment: { type: String, default: "" },
    pageUrl: { type: String }, // Track which page they were on
    userAgent: { type: String }, // Browser info
  },
  { timestamps: true }
);

feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ userId: 1, createdAt: -1 });

export const Feedback = mongoose.models.Feedback || mongoose.model("Feedback", feedbackSchema);
