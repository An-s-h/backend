import mongoose from "mongoose";

const feedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    userRole: { type: String, enum: ["patient", "researcher"], required: true },
    username: { type: String, required: true },
    email: { type: String },
    rating: { type: String, required: true }, // "excellent", "good", "average", "poor"
    comment: { type: String, default: "" },
    pageUrl: { type: String }, // Track which page they were on
    userAgent: { type: String }, // Browser info

    // Structured survey fields (for Collabiora feedback modal)
    surveyRole: { type: String }, // Q1: "patient" | "researcher" | "both" | "other"
    surveyPurposes: [{ type: String }], // Q2: array of purposes
    surveyExperience: { type: String }, // Q3: "excellent" | "good" | "fair" | "poor" | "very-frustrating"
    surveyFound: { type: String }, // Q4
    surveyMostValuable: [{ type: String }], // Q5
    surveyConfusing: [{ type: String }], // Q6
    surveyReturnLikelihood: { type: Number }, // Q7: 0-10
    surveyImprovement: { type: String }, // Q8: free text
    surveyWhatMatters: [{ type: String }], // Q9: what matters most (role-based options)
  },
  { timestamps: true },
);

feedbackSchema.index({ createdAt: -1 });
feedbackSchema.index({ userId: 1, createdAt: -1 });

export const Feedback =
  mongoose.models.Feedback || mongoose.model("Feedback", feedbackSchema);
