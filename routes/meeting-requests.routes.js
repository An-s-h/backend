import { Router } from "express";
import mongoose from "mongoose";
import { MeetingRequest } from "../models/MeetingRequest.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

const router = Router();

// Send a meeting request (patient to expert)
router.post("/meeting-requests", async (req, res) => {
  try {
    const { patientId, expertId, message, preferredDate, preferredTime } = req.body;

    if (!patientId || !expertId || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (patientId === expertId) {
      return res.status(400).json({ error: "Cannot send meeting request to yourself" });
    }

    // Convert string IDs to ObjectIds if needed
    const patientIdObj = mongoose.Types.ObjectId.isValid(patientId) 
      ? new mongoose.Types.ObjectId(patientId) 
      : patientId;
    const expertIdObj = mongoose.Types.ObjectId.isValid(expertId)
      ? new mongoose.Types.ObjectId(expertId)
      : expertId;

    // Check if a pending request already exists
    const existingRequest = await MeetingRequest.findOne({
      patientId: patientIdObj,
      expertId: expertIdObj,
      status: "pending"
    });

    if (existingRequest) {
      return res.status(400).json({ error: "A pending meeting request already exists" });
    }

    const meetingRequest = await MeetingRequest.create({
      patientId: patientIdObj,
      expertId: expertIdObj,
      message,
      preferredDate: preferredDate ? new Date(preferredDate) : null,
      preferredTime: preferredTime || null,
      status: "pending",
    });

    // Create notification for expert
    const patient = await User.findById(patientIdObj).lean();
    await Notification.create({
      userId: expertIdObj,
      type: "meeting_request",
      relatedUserId: patientIdObj,
      relatedItemId: meetingRequest._id,
      relatedItemType: "meeting_request",
      title: "New Meeting Request",
      message: `${patient?.username || "Someone"} sent you a meeting request`,
      metadata: {
        patientUsername: patient?.username,
        requestId: meetingRequest._id.toString(),
      },
    });

    res.json({ ok: true, meetingRequest });
  } catch (error) {
    console.error("Error sending meeting request:", error);
    res.status(500).json({ error: "Failed to send meeting request" });
  }
});

// Get meeting requests for an expert
router.get("/meeting-requests/:expertId", async (req, res) => {
  try {
    const { expertId } = req.params;
    const { status } = req.query;

    // Convert string ID to ObjectId
    const expertIdObj = mongoose.Types.ObjectId.isValid(expertId) 
      ? new mongoose.Types.ObjectId(expertId) 
      : expertId;

    let query = { expertId: expertIdObj };
    if (status) {
      query.status = status;
    }

    const requests = await MeetingRequest.find(query)
      .populate("patientId", "username email")
      .populate("expertId", "username email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ requests });
  } catch (error) {
    console.error("Error fetching meeting requests:", error);
    res.status(500).json({ error: "Failed to fetch meeting requests" });
  }
});

// Get meeting requests sent by a patient
router.get("/meeting-requests/patient/:patientId", async (req, res) => {
  try {
    const { patientId } = req.params;
    const { status } = req.query;

    // Convert string ID to ObjectId
    const patientIdObj = mongoose.Types.ObjectId.isValid(patientId) 
      ? new mongoose.Types.ObjectId(patientId) 
      : patientId;

    let query = { patientId: patientIdObj };
    if (status) {
      query.status = status;
    }

    const requests = await MeetingRequest.find(query)
      .populate("patientId", "username email")
      .populate("expertId", "username email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ requests });
  } catch (error) {
    console.error("Error fetching meeting requests:", error);
    res.status(500).json({ error: "Failed to fetch meeting requests" });
  }
});

// Check meeting request status between patient and expert
router.get("/meeting-requests/:patientId/:expertId/status", async (req, res) => {
  try {
    const { patientId, expertId } = req.params;

    // Convert string IDs to ObjectIds
    const patientIdObj = mongoose.Types.ObjectId.isValid(patientId) 
      ? new mongoose.Types.ObjectId(patientId) 
      : patientId;
    const expertIdObj = mongoose.Types.ObjectId.isValid(expertId)
      ? new mongoose.Types.ObjectId(expertId)
      : expertId;

    const request = await MeetingRequest.findOne({
      patientId: patientIdObj,
      expertId: expertIdObj,
    }).lean();

    if (!request) {
      return res.json({ hasRequest: false, status: null });
    }

    res.json({
      hasRequest: true,
      status: request.status,
      request,
    });
  } catch (error) {
    console.error("Error checking meeting request status:", error);
    res.status(500).json({ error: "Failed to check meeting request status" });
  }
});

// Accept, reject, or cancel a meeting request
router.patch("/meeting-requests/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action, meetingDate, meetingNotes } = req.body; // "accept", "reject", or "cancelled"

    if (!action || !["accept", "reject", "cancelled"].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Must be 'accept', 'reject', or 'cancelled'" });
    }

    const status = action === "accept" ? "accepted" : action === "reject" ? "rejected" : "cancelled";
    
    const updateData = {
      status,
      respondedAt: action !== "cancelled" ? new Date() : null,
    };

    if (action === "accept" && meetingDate) {
      updateData.meetingDate = new Date(meetingDate);
    }

    if (meetingNotes) {
      updateData.meetingNotes = meetingNotes;
    }

    const meetingRequest = await MeetingRequest.findByIdAndUpdate(
      requestId,
      updateData,
      { new: true }
    ).populate("patientId", "username email")
     .populate("expertId", "username email");

    if (!meetingRequest) {
      return res.status(404).json({ error: "Meeting request not found" });
    }

    // Create notification for patient
    const expert = await User.findById(meetingRequest.expertId).lean();
    await Notification.create({
      userId: meetingRequest.patientId._id || meetingRequest.patientId,
      type: `meeting_request_${status}`,
      relatedUserId: meetingRequest.expertId._id || meetingRequest.expertId,
      relatedItemId: meetingRequest._id,
      relatedItemType: "meeting_request",
      title: action === "accept" ? "Meeting Request Accepted" : action === "reject" ? "Meeting Request Rejected" : "Meeting Request Cancelled",
      message: action === "accept"
        ? `${expert?.username || "The expert"} accepted your meeting request.`
        : action === "reject"
        ? `${expert?.username || "The expert"} rejected your meeting request.`
        : `${expert?.username || "The expert"} cancelled the meeting request.`,
      metadata: {
        expertUsername: expert?.username,
        requestId: meetingRequest._id.toString(),
        status,
        meetingDate: meetingRequest.meetingDate,
      },
    });

    res.json({ ok: true, meetingRequest });
  } catch (error) {
    console.error("Error updating meeting request:", error);
    res.status(500).json({ error: "Failed to update meeting request" });
  }
});

// Update meeting request with accepted meeting date/time (expert accepts meeting time)
router.patch("/meeting-requests/:requestId/accept-time", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { meetingDate, meetingNotes } = req.body;

    if (!meetingDate) {
      return res.status(400).json({ error: "Meeting date is required" });
    }

    const meetingRequest = await MeetingRequest.findByIdAndUpdate(
      requestId,
      { 
        meetingDate: new Date(meetingDate),
        meetingNotes: meetingNotes || null,
        status: "accepted",
      },
      { new: true }
    ).populate("patientId", "username email")
     .populate("expertId", "username email");

    if (!meetingRequest) {
      return res.status(404).json({ error: "Meeting request not found" });
    }

    // Create notification for patient
    const expert = await User.findById(meetingRequest.expertId).lean();
    await Notification.create({
      userId: meetingRequest.patientId._id || meetingRequest.patientId,
      type: "meeting_request_accepted",
      relatedUserId: meetingRequest.expertId._id || meetingRequest.expertId,
      relatedItemId: meetingRequest._id,
      relatedItemType: "meeting_request",
      title: "Meeting Scheduled",
      message: `${expert?.username || "The expert"} accepted your meeting request and scheduled it for ${new Date(meetingDate).toLocaleDateString()}`,
      metadata: {
        expertUsername: expert?.username,
        requestId: meetingRequest._id.toString(),
        meetingDate: meetingRequest.meetingDate,
      },
    });

    res.json({ ok: true, meetingRequest });
  } catch (error) {
    console.error("Error accepting meeting time:", error);
    res.status(500).json({ error: "Failed to accept meeting time" });
  }
});

export default router;

