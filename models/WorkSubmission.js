import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
  },
  { _id: false }
);

const workSubmissionSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ["publication", "trial"],
      required: true,
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
      index: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Publication fields
    title: String,
    year: Number,
    journal: String,
    doi: String,
    pmid: String,
    link: String,
    authors: [{ type: String }],
    source: String,

    // Trial fields
    trialStatus: String,
    phase: String,
    location: String,
    eligibility: String,
    description: String,
    contacts: [contactSchema],

    reviewedAt: Date,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    adminNote: String,
  },
  { timestamps: true }
);

export const WorkSubmission =
  mongoose.models.WorkSubmission ||
  mongoose.model("WorkSubmission", workSubmissionSchema);
