import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    city: String,
    country: String,
  },
  { _id: false }
);

const patientSchema = new mongoose.Schema(
  {
    conditions: [{ type: String }],
    location: locationSchema,
    keywords: [{ type: String }],
    gender: String,
  },
  { _id: false }
);

const educationSchema = new mongoose.Schema(
  {
    institution: String,
    degree: String,
    field: String,
    year: String,
  },
  { _id: false }
);

const researcherSchema = new mongoose.Schema(
  {
    specialties: [{ type: String }],
    interests: [{ type: String }],
    orcid: String,
    researchGate: String,
    available: { type: Boolean, default: false },
    bio: String,
    location: locationSchema,
    gender: String,
    isVerified: { type: Boolean, default: false },
    // New fields for enhanced researcher profile
    education: [educationSchema],
    skills: [{ type: String }],
    meetingRate: Number, // Rate per 30 minutes in USD
    interestedInMeetings: { type: Boolean, default: false },
    interestedInForums: { type: Boolean, default: false },
  },
  { _id: false }
);

const profileSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      index: true,
      required: true,
    },
    role: { type: String, enum: ["patient", "researcher"], required: true },
    patient: patientSchema,
    researcher: researcherSchema,
  },
  { timestamps: true }
);

export const Profile =
  mongoose.models.Profile || mongoose.model("Profile", profileSchema);
