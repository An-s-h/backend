import mongoose from "mongoose";

const waitlistSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: true,
      trim: true
    },
    lastName: {
      type: String,
      required: true,
      trim: true
    },
    name: {
      type: String,
      required: false,
      trim: true
    },
    email: { 
      type: String, 
      required: true, 
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    role: {
      type: String,
      enum: ["patient", "researcher", "caregiver"],
      required: false
    },
    country: {
      type: String,
      required: false,
      trim: true
    },
    subscribedAt: { 
      type: Date, 
      default: Date.now 
    },
    notified: {
      type: Boolean,
      default: false
    },
    notifiedAt: {
      type: Date
    }
  },
  { timestamps: true }
);

// Ensure email is unique
waitlistSchema.index({ email: 1 }, { unique: true });

export const Waitlist = mongoose.models.Waitlist || mongoose.model("Waitlist", waitlistSchema);

