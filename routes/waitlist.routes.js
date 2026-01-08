import express from "express";
import { Waitlist } from "../models/Waitlist.js";

const router = express.Router();

// Add to waitlist
router.post("/waitlist", async (req, res) => {
  try {
    const { firstName, lastName, email, role, country } = req.body;

    // Validation
    if (!firstName || !firstName.trim()) {
      return res.status(400).json({ error: "First name is required" });
    }

    if (!lastName || !lastName.trim()) {
      return res.status(400).json({ error: "Last name is required" });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Email is required" });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Invalid email format" });
    }

    // Validate role if provided
    if (
      role &&
      !["patient", "researcher", "caregiver"].includes(role.toLowerCase())
    ) {
      return res.status(400).json({
        error: "Invalid role. Must be Patient, Researcher, or Caregiver",
      });
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
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      name: `${firstName.trim()} ${lastName.trim()}`, // Keep name for backward compatibility
      email: email.toLowerCase().trim(),
      ...(role && { role: role.toLowerCase() }),
      ...(country && { country: country.trim() }),
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
