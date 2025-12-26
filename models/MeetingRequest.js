import mongoose from "mongoose";

const meetingRequestSchema = new mongoose.Schema(
  {
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    expertId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
    message: { type: String, required: true },
    preferredDate: { type: Date },
    preferredTime: { type: String },
    status: { 
      type: String, 
      enum: ["pending", "accepted", "rejected", "cancelled"], 
      default: "pending",
      index: true
    },
    respondedAt: { type: Date },
    meetingDate: { type: Date },
    meetingNotes: { type: String },
  },
  { timestamps: true }
);

// Index for quick lookup of meeting requests
meetingRequestSchema.index({ patientId: 1, expertId: 1, status: 1 });
meetingRequestSchema.index({ expertId: 1, status: 1 });

export const MeetingRequest = mongoose.models.MeetingRequest || mongoose.model("MeetingRequest", meetingRequestSchema);

