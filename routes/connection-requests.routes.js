import { Router } from "express";
import mongoose from "mongoose";
import { ConnectionRequest } from "../models/ConnectionRequest.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

const router = Router();

// Send a connection request (researcher to researcher)
router.post("/connection-requests", async (req, res) => {
  try {
    const { requesterId, receiverId, message } = req.body;

    if (!requesterId || !receiverId) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (requesterId === receiverId) {
      return res.status(400).json({ error: "Cannot send connection request to yourself" });
    }

    // Convert string IDs to ObjectIds if needed
    const requesterIdObj = mongoose.Types.ObjectId.isValid(requesterId) 
      ? new mongoose.Types.ObjectId(requesterId) 
      : requesterId;
    const receiverIdObj = mongoose.Types.ObjectId.isValid(receiverId)
      ? new mongoose.Types.ObjectId(receiverId)
      : receiverId;

    // Check if a pending request already exists (either direction)
    const existingRequest1 = await ConnectionRequest.findOne({
      requesterId: requesterIdObj,
      receiverId: receiverIdObj,
      status: "pending"
    });

    const existingRequest2 = await ConnectionRequest.findOne({
      requesterId: receiverIdObj,
      receiverId: requesterIdObj,
      status: "pending"
    });

    if (existingRequest1 || existingRequest2) {
      return res.status(400).json({ error: "A pending connection request already exists" });
    }

    // Check if already connected
    const existingConnection1 = await ConnectionRequest.findOne({
      requesterId: requesterIdObj,
      receiverId: receiverIdObj,
      status: "accepted"
    });

    const existingConnection2 = await ConnectionRequest.findOne({
      requesterId: receiverIdObj,
      receiverId: requesterIdObj,
      status: "accepted"
    });

    if (existingConnection1 || existingConnection2) {
      return res.status(400).json({ error: "You are already connected with this researcher" });
    }

    const connectionRequest = await ConnectionRequest.create({
      requesterId: requesterIdObj,
      receiverId: receiverIdObj,
      message: message || "",
      status: "pending",
    });

    // Create notification for receiver
    const requester = await User.findById(requesterIdObj).lean();
    await Notification.create({
      userId: receiverIdObj,
      type: "connection_request",
      relatedUserId: requesterIdObj,
      relatedItemId: connectionRequest._id,
      relatedItemType: "connection_request",
      title: "New Connection Request",
      message: `${requester?.username || "Someone"} sent you a connection request`,
      metadata: {
        requesterUsername: requester?.username,
        requestId: connectionRequest._id.toString(),
      },
    });

    res.json({ ok: true, connectionRequest });
  } catch (error) {
    console.error("Error sending connection request:", error);
    if (error.code === 11000) {
      return res.status(400).json({ error: "A connection request already exists between these researchers" });
    }
    res.status(500).json({ error: "Failed to send connection request" });
  }
});

// Get connection requests for a researcher
router.get("/connection-requests/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { status, type } = req.query; // type: "sent" or "received"

    // Convert string ID to ObjectId
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;

    let query = {};
    if (type === "sent") {
      query = { requesterId: userIdObj };
    } else if (type === "received") {
      query = { receiverId: userIdObj };
    } else {
      query = { $or: [{ requesterId: userIdObj }, { receiverId: userIdObj }] };
    }

    if (status) {
      query.status = status;
    }

    const requests = await ConnectionRequest.find(query)
      .populate("requesterId", "username email")
      .populate("receiverId", "username email")
      .sort({ createdAt: -1 })
      .lean();

    res.json({ requests });
  } catch (error) {
    console.error("Error fetching connection requests:", error);
    res.status(500).json({ error: "Failed to fetch connection requests" });
  }
});

// Check connection status between two researchers
router.get("/connection-requests/:requesterId/:receiverId/status", async (req, res) => {
  try {
    const { requesterId, receiverId } = req.params;

    // Convert string IDs to ObjectIds
    const requesterIdObj = mongoose.Types.ObjectId.isValid(requesterId) 
      ? new mongoose.Types.ObjectId(requesterId) 
      : requesterId;
    const receiverIdObj = mongoose.Types.ObjectId.isValid(receiverId)
      ? new mongoose.Types.ObjectId(receiverId)
      : receiverId;

    // Check both directions
    const request1 = await ConnectionRequest.findOne({
      requesterId: requesterIdObj,
      receiverId: receiverIdObj,
    }).lean();

    const request2 = await ConnectionRequest.findOne({
      requesterId: receiverIdObj,
      receiverId: requesterIdObj,
    }).lean();

    const request = request1 || request2;

    if (!request) {
      return res.json({ hasRequest: false, isConnected: false, status: null });
    }

    const isConnected = request.status === "accepted";
    const isRequester = request.requesterId.toString() === requesterIdObj.toString();

    res.json({
      hasRequest: true,
      isConnected,
      status: request.status,
      isRequester,
      request,
    });
  } catch (error) {
    console.error("Error checking connection status:", error);
    res.status(500).json({ error: "Failed to check connection status" });
  }
});

// Accept or reject a connection request
router.patch("/connection-requests/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { action } = req.body; // "accept" or "reject"

    if (!action || !["accept", "reject"].includes(action)) {
      return res.status(400).json({ error: "Invalid action. Must be 'accept' or 'reject'" });
    }

    const status = action === "accept" ? "accepted" : "rejected";
    const connectionRequest = await ConnectionRequest.findByIdAndUpdate(
      requestId,
      { status, respondedAt: new Date() },
      { new: true }
    ).populate("requesterId", "username email")
     .populate("receiverId", "username email");

    if (!connectionRequest) {
      return res.status(404).json({ error: "Connection request not found" });
    }

    // Create notification for requester
    const receiver = await User.findById(connectionRequest.receiverId).lean();
    await Notification.create({
      userId: connectionRequest.requesterId._id || connectionRequest.requesterId,
      type: `connection_request_${status}`,
      relatedUserId: connectionRequest.receiverId._id || connectionRequest.receiverId,
      relatedItemId: connectionRequest._id,
      relatedItemType: "connection_request",
      title: action === "accept" ? "Connection Request Accepted" : "Connection Request Rejected",
      message: action === "accept"
        ? `${receiver?.username || "The researcher"} accepted your connection request. You can now send messages.`
        : `${receiver?.username || "The researcher"} rejected your connection request.`,
      metadata: {
        receiverUsername: receiver?.username,
        requestId: connectionRequest._id.toString(),
        status,
      },
    });

    res.json({ ok: true, connectionRequest });
  } catch (error) {
    console.error("Error updating connection request:", error);
    res.status(500).json({ error: "Failed to update connection request" });
  }
});

// Delete/disconnect a connection (remove connection)
router.delete("/connection-requests/:requestId", async (req, res) => {
  try {
    const { requestId } = req.params;
    const { userId } = req.query; // Get userId from query params

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const connectionRequest = await ConnectionRequest.findById(requestId);

    if (!connectionRequest) {
      return res.status(404).json({ error: "Connection request not found" });
    }

    // Only allow deletion if connection is accepted
    if (connectionRequest.status !== "accepted") {
      return res.status(400).json({ error: "Can only disconnect accepted connections" });
    }

    // Verify that the userId is part of this connection
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;
    
    const requesterIdStr = connectionRequest.requesterId.toString();
    const receiverIdStr = connectionRequest.receiverId.toString();
    const userIdStr = userIdObj.toString();

    if (requesterIdStr !== userIdStr && receiverIdStr !== userIdStr) {
      return res.status(403).json({ error: "You can only disconnect your own connections" });
    }

    // Get the other user ID before deleting
    const otherUserId = requesterIdStr === userIdStr 
      ? connectionRequest.receiverId 
      : connectionRequest.requesterId;

    // Delete the connection
    await ConnectionRequest.findByIdAndDelete(requestId);

    // Create notification for the other party
    const disconnectedBy = await User.findById(userIdObj).lean();
    await Notification.create({
      userId: otherUserId,
      type: "new_message", // Using existing type
      relatedUserId: userIdObj,
      title: "Connection Disconnected",
      message: `${disconnectedBy?.username || "Someone"} disconnected from you`,
      metadata: {
        disconnectedByUsername: disconnectedBy?.username,
      },
    });

    res.json({ ok: true, message: "Connection disconnected successfully" });
  } catch (error) {
    console.error("Error disconnecting connection:", error);
    res.status(500).json({ error: "Failed to disconnect connection" });
  }
});

// Get all accepted connections for a researcher
router.get("/connection-requests/:userId/connections", async (req, res) => {
  try {
    const { userId } = req.params;

    // Convert string ID to ObjectId
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;

    // Get all accepted connections (both as requester and receiver)
    const asRequester = await ConnectionRequest.find({
      requesterId: userIdObj,
      status: "accepted"
    })
      .populate("receiverId", "username email")
      .lean();

    const asReceiver = await ConnectionRequest.find({
      receiverId: userIdObj,
      status: "accepted"
    })
      .populate("requesterId", "username email")
      .lean();

    // Format connections
    const connections = [
      ...asRequester.map(c => ({
        _id: c._id,
        userId: c.receiverId._id || c.receiverId,
        username: c.receiverId.username,
        email: c.receiverId.email,
        connectedAt: c.respondedAt || c.createdAt,
        isRequester: true,
      })),
      ...asReceiver.map(c => ({
        _id: c._id,
        userId: c.requesterId._id || c.requesterId,
        username: c.requesterId.username,
        email: c.requesterId.email,
        connectedAt: c.respondedAt || c.createdAt,
        isRequester: false,
      })),
    ];

    res.json({ connections });
  } catch (error) {
    console.error("Error fetching connections:", error);
    res.status(500).json({ error: "Failed to fetch connections" });
  }
});

export default router;

