import { Router } from "express";
import mongoose from "mongoose";
import { ExpertInvite } from "../models/ExpertInvite.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

const router = Router();

// Send an invite to a global expert
router.post("/expert-invites", async (req, res) => {
  try {
    const { inviterId, expertName, expertOrcid, expertAffiliation, expertLocation } = req.body;

    if (!inviterId || !expertName) {
      return res.status(400).json({ error: "Missing required fields: inviterId and expertName are required" });
    }

    // Convert string ID to ObjectId if needed
    const inviterIdObj = mongoose.Types.ObjectId.isValid(inviterId) 
      ? new mongoose.Types.ObjectId(inviterId) 
      : inviterId;

    // Check if user exists
    const inviter = await User.findById(inviterIdObj).lean();
    if (!inviter) {
      return res.status(404).json({ error: "User not found" });
    }

    // Check if invite already exists
    const inviteQuery = {
      inviterId: inviterIdObj,
      expertName: expertName.trim(),
    };

    // Include ORCID in query if provided
    if (expertOrcid) {
      inviteQuery.expertOrcid = expertOrcid.trim();
    } else {
      inviteQuery.expertOrcid = null;
    }

    const existingInvite = await ExpertInvite.findOne(inviteQuery);

    if (existingInvite) {
      return res.status(400).json({ 
        error: "You have already invited this expert",
        invite: existingInvite 
      });
    }

    // Create new invite
    const expertInvite = await ExpertInvite.create({
      inviterId: inviterIdObj,
      expertName: expertName.trim(),
      expertOrcid: expertOrcid ? expertOrcid.trim() : null,
      expertAffiliation: expertAffiliation || null,
      expertLocation: expertLocation || null,
      status: "pending",
      invitedAt: new Date(),
    });

    // Create notification for admin (optional - can be implemented later)
    // For now, just return success

    res.status(201).json({ 
      success: true,
      message: "Invite sent successfully",
      invite: expertInvite 
    });
  } catch (error) {
    console.error("Error sending expert invite:", error);
    
    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(400).json({ 
        error: "You have already invited this expert" 
      });
    }
    
    res.status(500).json({ error: "Failed to send invite" });
  }
});

// Check if user has invited a specific expert
router.get("/expert-invites/check", async (req, res) => {
  try {
    const { inviterId, expertName, expertOrcid } = req.query;

    if (!inviterId || !expertName) {
      return res.status(400).json({ error: "Missing required fields: inviterId and expertName are required" });
    }

    // Convert string ID to ObjectId if needed
    const inviterIdObj = mongoose.Types.ObjectId.isValid(inviterId) 
      ? new mongoose.Types.ObjectId(inviterId) 
      : inviterId;

    // Build query
    const inviteQuery = {
      inviterId: inviterIdObj,
      expertName: expertName.trim(),
    };

    // Include ORCID in query if provided
    if (expertOrcid) {
      inviteQuery.expertOrcid = expertOrcid.trim();
    } else {
      inviteQuery.expertOrcid = null;
    }

    const invite = await ExpertInvite.findOne(inviteQuery).lean();

    res.json({ 
      hasInvited: !!invite,
      invite: invite || null
    });
  } catch (error) {
    console.error("Error checking expert invite:", error);
    res.status(500).json({ error: "Failed to check invite status" });
  }
});

// Get all invites sent by a user
router.get("/expert-invites/user/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Convert string ID to ObjectId if needed
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;

    const invites = await ExpertInvite.find({ inviterId: userIdObj })
      .sort({ invitedAt: -1 })
      .lean();

    res.json({ invites });
  } catch (error) {
    console.error("Error fetching user invites:", error);
    res.status(500).json({ error: "Failed to fetch invites" });
  }
});

export default router;

