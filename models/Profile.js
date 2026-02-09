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
    age: Number, // Optional age field
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

const selectedPublicationSchema = new mongoose.Schema(
  {
    title: String,
    year: Number,
    journal: String,
    journalTitle: String,
    doi: String,
    pmid: String,
    link: String,
    url: String,
    authors: [{ type: String }],
    type: String,
    openalexId: String,
    orcidWorkId: String,
    source: String,
  },
  { _id: false }
);

const researcherSchema = new mongoose.Schema(
  {
    profession: String, // e.g. MD, PhD, RN, PharmD, etc.
    academicRank: String, // e.g. Professor, Associate Professor, etc.
    specialties: [{ type: String }],
    interests: [{ type: String }],
    certifications: [{ type: String }],
    orcid: String,
    researchGate: String,
    researchGateVerification: { type: String, enum: ["pending", "verified"], default: null },
    academiaEdu: String,
    academiaEduVerification: { type: String, enum: ["pending", "verified"], default: null },
    institutionAffiliation: String,
    available: { type: Boolean, default: false },
    bio: String,
    location: locationSchema,
    gender: String,
    age: Number, // Optional age field
    isVerified: { type: Boolean, default: false },
    verificationDocumentUrl: String, // URL for verification document when ORCID is not available
    // New fields for enhanced researcher profile
    education: [educationSchema],
    skills: [{ type: String }],
    meetingRate: Number, // Rate per 30 minutes in USD
    interestedInMeetings: { type: Boolean, default: false },
    interestedInForums: { type: Boolean, default: false },
    // Publications the researcher has chosen to display on their public profile
    selectedPublications: [selectedPublicationSchema],
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
