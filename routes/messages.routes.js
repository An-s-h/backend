import { Router } from "express";
import mongoose from "mongoose";
import { Message } from "../models/Message.js";
import { ConnectionRequest } from "../models/ConnectionRequest.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";

const router = Router();

// Send a message
router.post("/messages", async (req, res) => {
  try {
    const { senderId, receiverId, senderRole, receiverRole, subject, body } = req.body;

    if (!senderId || !receiverId || !senderRole || !receiverRole || !body) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (senderId === receiverId) {
      return res.status(400).json({ error: "Cannot send message to yourself" });
    }

    // Convert string IDs to ObjectIds if needed
    const senderIdObj = mongoose.Types.ObjectId.isValid(senderId) 
      ? new mongoose.Types.ObjectId(senderId) 
      : senderId;
    const receiverIdObj = mongoose.Types.ObjectId.isValid(receiverId)
      ? new mongoose.Types.ObjectId(receiverId)
      : receiverId;

    // Patients cannot send messages - they can only request meetings
    if (senderRole === "patient") {
      return res.status(403).json({ 
        error: "Patients cannot send messages. Please request a meeting with the expert instead." 
      });
    }

    // Researchers can only message other connected researchers
    if (senderRole === "researcher" && receiverRole === "researcher") {
      // Check if both users are connected (either direction)
      const connection1 = await ConnectionRequest.findOne({
        requesterId: senderIdObj,
        receiverId: receiverIdObj,
        status: "accepted"
      });
      
      const connection2 = await ConnectionRequest.findOne({
        requesterId: receiverIdObj,
        receiverId: senderIdObj,
        status: "accepted"
      });

      if (!connection1 && !connection2) {
        return res.status(403).json({ 
          error: "You are not connected with this researcher. Please send a connection request first." 
        });
      }
    }

    const message = await Message.create({
      senderId: senderIdObj,
      receiverId: receiverIdObj,
      senderRole,
      receiverRole,
      subject: subject || "",
      body,
    });

    // Create notification for receiver
    const sender = await User.findById(senderIdObj).lean();
    await Notification.create({
      userId: receiverIdObj,
      type: "new_message",
      relatedUserId: senderIdObj,
      relatedItemId: message._id,
      relatedItemType: "message",
      title: "New Message",
      message: `You received a message from ${sender?.username || "Someone"}`,
      metadata: {
        senderUsername: sender?.username,
        subject: subject || "",
      },
    });

    res.json({ ok: true, message });
  } catch (error) {
    console.error("Error sending message:", error);
    res.status(500).json({ error: "Failed to send message" });
  }
});

// Get messages for a conversation
router.get("/messages/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { conversationWith } = req.query;

    // Convert string IDs to ObjectIds
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;

    let query = { $or: [{ senderId: userIdObj }, { receiverId: userIdObj }] };
    
    if (conversationWith) {
      const conversationWithObj = mongoose.Types.ObjectId.isValid(conversationWith)
        ? new mongoose.Types.ObjectId(conversationWith)
        : conversationWith;
      
      query = {
        $or: [
          { senderId: userIdObj, receiverId: conversationWithObj },
          { senderId: conversationWithObj, receiverId: userIdObj },
        ],
      };
    }

    const messages = await Message.find(query)
      .populate("senderId", "username email")
      .populate("receiverId", "username email")
      .sort({ createdAt: 1 })
      .lean();

    res.json({ messages });
  } catch (error) {
    console.error("Error fetching messages:", error);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Get conversations list
router.get("/messages/:userId/conversations", async (req, res) => {
  try {
    const { userId } = req.params;

    // Convert string ID to ObjectId
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;
    const userIdStr = userIdObj.toString();

    const messages = await Message.find({
      $or: [{ senderId: userIdObj }, { receiverId: userIdObj }],
    })
      .populate("senderId", "username email")
      .populate("receiverId", "username email")
      .sort({ createdAt: -1 })
      .lean();

    const conversationsMap = {};
    messages.forEach((msg) => {
      const senderIdStr = msg.senderId._id?.toString() || msg.senderId.id?.toString() || msg.senderId?.toString();
      const receiverIdStr = msg.receiverId._id?.toString() || msg.receiverId.id?.toString() || msg.receiverId?.toString();
      
      const otherUserId = senderIdStr === userIdStr 
        ? receiverIdStr
        : senderIdStr;
      
      if (!conversationsMap[otherUserId]) {
        conversationsMap[otherUserId] = {
          userId: otherUserId,
          username: senderIdStr === userIdStr 
            ? msg.receiverId.username 
            : msg.senderId.username,
          email: senderIdStr === userIdStr 
            ? msg.receiverId.email 
            : msg.senderId.email,
          lastMessage: msg,
          unreadCount: 0,
        };
      }
      
      if (new Date(msg.createdAt) > new Date(conversationsMap[otherUserId].lastMessage.createdAt)) {
        conversationsMap[otherUserId].lastMessage = msg;
      }
      
      if (receiverIdStr === userIdStr && !msg.read) {
        conversationsMap[otherUserId].unreadCount++;
      }
    });

    const conversations = Object.values(conversationsMap).sort(
      (a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt)
    );

    res.json({ conversations });
  } catch (error) {
    console.error("Error fetching conversations:", error);
    res.status(500).json({ error: "Failed to fetch conversations" });
  }
});

// Mark message as read
router.patch("/messages/:messageId/read", async (req, res) => {
  try {
    const { messageId } = req.params;
    await Message.findByIdAndUpdate(messageId, { read: true });
    res.json({ ok: true });
  } catch (error) {
    console.error("Error marking message as read:", error);
    res.status(500).json({ error: "Failed to mark message as read" });
  }
});

// Mark all messages in a conversation as read
router.patch("/messages/:userId/conversation/:otherUserId/read", async (req, res) => {
  try {
    const { userId, otherUserId } = req.params;
    
    // Convert string IDs to ObjectIds
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;
    const otherUserIdObj = mongoose.Types.ObjectId.isValid(otherUserId)
      ? new mongoose.Types.ObjectId(otherUserId)
      : otherUserId;
    
    await Message.updateMany(
      { senderId: otherUserIdObj, receiverId: userIdObj, read: false },
      { read: true }
    );
    res.json({ ok: true });
  } catch (error) {
    console.error("Error marking conversation as read:", error);
    res.status(500).json({ error: "Failed to mark conversation as read" });
  }
});

// Get unread message count
router.get("/messages/:userId/unread-count", async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Convert string ID to ObjectId
    const userIdObj = mongoose.Types.ObjectId.isValid(userId) 
      ? new mongoose.Types.ObjectId(userId) 
      : userId;
    
    const count = await Message.countDocuments({ receiverId: userIdObj, read: false });
    res.json({ count });
  } catch (error) {
    console.error("Error fetching unread count:", error);
    res.status(500).json({ error: "Failed to fetch unread count" });
  }
});

export default router;

