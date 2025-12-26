import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    type: {
      type: String,
      enum: [
        "new_reply",
        "new_follower",
        "new_trial_match",
        "thread_upvoted",
        "reply_upvoted",
        "new_publication",
        "researcher_replied",
        "new_message",
        "patient_question",
        "connection_request",
        "connection_request_accepted",
        "connection_request_rejected",
        "meeting_request",
        "meeting_request_accepted",
        "meeting_request_rejected",
        "meeting_request_cancelled",
      ],
      required: true,
    },
    relatedUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    relatedItemId: { type: mongoose.Schema.Types.ObjectId },
    relatedItemType: { type: String },
    title: { type: String, required: true },
    message: { type: String, required: true },
    read: { type: Boolean, default: false },
    metadata: { type: Object, default: {} },
  },
  { timestamps: true }
);

notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.models.Notification || mongoose.model("Notification", notificationSchema);

