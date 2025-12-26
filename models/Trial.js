import mongoose from "mongoose";

const contactSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
  },
  { _id: false }
);

const trialSchema = new mongoose.Schema(
  {
    ownerResearcherId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    title: { type: String, required: true },
    status: String,
    phase: String,
    location: String,
    eligibility: String,
    description: String,
    contacts: [contactSchema],
  },
  { timestamps: true }
);

export const Trial = mongoose.models.Trial || mongoose.model("Trial", trialSchema);


