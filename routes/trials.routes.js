import { Router } from "express";
import { Trial } from "../models/Trial.js";

const router = Router();

// Create
router.post("/trials", async (req, res) => {
  const payload = req.body || {};
  if (!payload.title) return res.status(400).json({ error: "title required" });
  const trial = await Trial.create(payload);
  res.json({ ok: true, trial });
});

// Update
router.put("/trials/:trialId", async (req, res) => {
  const { trialId } = req.params;
  const payload = req.body || {};
  const trial = await Trial.findByIdAndUpdate(trialId, payload, { new: true });
  res.json({ ok: true, trial });
});

// List by owner
router.get("/trials", async (req, res) => {
  const { ownerResearcherId } = req.query;
  const q = ownerResearcherId ? { ownerResearcherId } : {};
  const trials = await Trial.find(q).sort({ createdAt: -1 });
  res.json({ trials });
});

export default router;


