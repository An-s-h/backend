import { Router } from "express";
import { Contact } from "../models/Contact.js";
import { User } from "../models/User.js";

const router = Router();

// Submit contact form
router.post("/contact", async (req, res) => {
  try {
    const { name, email, message, userId } = req.body;

    if (!name || !email || !message) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // Get IP address
    const ipAddress =
      req.headers["x-forwarded-for"]?.split(",")[0] ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      "Unknown";

    const contactData = {
      name: name.trim(),
      email: email.trim().toLowerCase(),
      message: message.trim(),
      ipAddress,
      userAgent: req.headers["user-agent"] || "Unknown",
    };

    // If userId is provided, verify the user exists and attach it
    if (userId) {
      const user = await User.findById(userId).lean();
      if (user) {
        contactData.userId = userId;
      }
    }

    const contact = await Contact.create(contactData);

    res.json({ ok: true, contact });
  } catch (error) {
    console.error("Error submitting contact form:", error);
    res.status(500).json({ error: "Failed to submit contact form" });
  }
});

// Get all contact submissions (admin only)
router.get("/contact", async (req, res) => {
  try {
    const { limit = 50, offset = 0, status } = req.query;

    const query = {};
    if (status && status !== "all") {
      query.status = status;
    }

    const contacts = await Contact.find(query)
      .populate("userId", "username email role")
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await Contact.countDocuments(query);

    res.json({
      contacts,
      total,
      limit: parseInt(limit),
      offset: parseInt(offset),
    });
  } catch (error) {
    console.error("Error fetching contacts:", error);
    res.status(500).json({ error: "Failed to fetch contacts" });
  }
});

// Get contact stats (admin only)
router.get("/contact/stats", async (req, res) => {
  try {
    const total = await Contact.countDocuments({});
    const newCount = await Contact.countDocuments({ status: "new" });
    const readCount = await Contact.countDocuments({ status: "read" });
    const repliedCount = await Contact.countDocuments({ status: "replied" });
    const resolvedCount = await Contact.countDocuments({ status: "resolved" });

    res.json({
      total,
      byStatus: {
        new: newCount,
        read: readCount,
        replied: repliedCount,
        resolved: resolvedCount,
      },
    });
  } catch (error) {
    console.error("Error fetching contact stats:", error);
    res.status(500).json({ error: "Failed to fetch contact stats" });
  }
});

// Update contact status (admin only)
router.patch("/contact/:id/status", async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!["new", "read", "replied", "resolved"].includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    const contact = await Contact.findByIdAndUpdate(
      id,
      { status },
      { new: true }
    ).lean();

    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json({ ok: true, contact });
  } catch (error) {
    console.error("Error updating contact status:", error);
    res.status(500).json({ error: "Failed to update contact status" });
  }
});

// Delete contact (admin only)
router.delete("/contact/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const contact = await Contact.findByIdAndDelete(id);

    if (!contact) {
      return res.status(404).json({ error: "Contact not found" });
    }

    res.json({ ok: true, message: "Contact deleted successfully" });
  } catch (error) {
    console.error("Error deleting contact:", error);
    res.status(500).json({ error: "Failed to delete contact" });
  }
});

export default router;
