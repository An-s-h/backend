import express from "express";
import { Waitlist } from "../models/Waitlist.js";

const router = express.Router();

// Add to waitlist
router.post("/waitlist", async (req, res) => {
  try {
    const { name, email, role } = req.body;

    // Validation
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Name is required" });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Check if email already exists
    const existing = await Waitlist.findOne({
      email: email.toLowerCase().trim(),
    });
    if (existing) {
      return res.status(200).json({
        message: "Email already registered",
        alreadyExists: true,
      });
    }

    // Add to waitlist
    const waitlistEntry = new Waitlist({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      ...(role && { role: role.toLowerCase() }),
    });

    await waitlistEntry.save();

    res.status(201).json({
      message: "Successfully added to waitlist",
      alreadyExists: false,
    });
  } catch (error) {
    console.error("Error adding to waitlist:", error);

    // Handle duplicate key error
    if (error.code === 11000) {
      return res.status(200).json({
        message: "Email already registered",
        alreadyExists: true,
      });
    }

    res.status(500).json({ error: "Failed to add to waitlist" });
  }
});

// Get waitlist count (optional, for admin/stats)
router.get("/waitlist/count", async (req, res) => {
  try {
    const count = await Waitlist.countDocuments();
    res.json({ count });
  } catch (error) {
    console.error("Error getting waitlist count:", error);
    res.status(500).json({ error: "Failed to get waitlist count" });
  }
});

export default router;
