import mongoose from "mongoose";

const pageFeedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: false,
      index: true,
    },
    username: { type: String, required: true },
    email: { type: String },
    userRole: {
      type: String,
      enum: ["patient", "researcher", "guest"],
      required: true,
    },
    feedback: { type: String, required: true }, // Free text feedback
    pagePath: { type: String, required: true }, // e.g., "/faq", "/trials"
    pageUrl: { type: String }, // Full URL
    userAgent: { type: String }, // Browser info
  },
  { timestamps: true },
);

pageFeedbackSchema.index({ createdAt: -1 });
pageFeedbackSchema.index({ userId: 1, createdAt: -1 });
pageFeedbackSchema.index({ pagePath: 1, createdAt: -1 });

export const PageFeedback =
  mongoose.models.PageFeedback || mongoose.model("PageFeedback", pageFeedbackSchema);
