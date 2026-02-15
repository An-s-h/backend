import mongoose from "mongoose";

const pageFeedbackSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
<<<<<<< HEAD
      required: false,
=======
      required: true,
>>>>>>> 3f8e8205a7aa54c4ad53b79b7152ff87798de62d
      index: true,
    },
    username: { type: String, required: true },
    email: { type: String },
<<<<<<< HEAD
    userRole: {
      type: String,
      enum: ["patient", "researcher", "guest"],
      required: true,
    },
=======
    userRole: { type: String, enum: ["patient", "researcher"], required: true },
>>>>>>> 3f8e8205a7aa54c4ad53b79b7152ff87798de62d
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
