import { Router } from "express";
import { verifySession } from "../middleware/auth.js";
import { Profile } from "../models/Profile.js";
import { WorkSubmission } from "../models/WorkSubmission.js";

const router = Router();

router.post("/work-submissions", verifySession, async (req, res) => {
  try {
    const payload = req.body || {};
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const profile = await Profile.findOne({ userId }).lean();
    if (!profile || profile.role !== "researcher") {
      return res
        .status(403)
        .json({ error: "Only researchers can submit work for moderation" });
    }

    if (!payload.type || !["publication", "trial"].includes(payload.type)) {
      return res
        .status(400)
        .json({ error: "type is required (publication or trial)" });
    }

    if (!payload.title || !String(payload.title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }

    const normalized = {
      type: payload.type,
      status: "pending",
      submittedBy: userId,
      title: String(payload.title).trim(),
    };

    if (payload.type === "publication") {
      normalized.year = payload.year ? Number(payload.year) : undefined;
      normalized.journal = payload.journal ? String(payload.journal).trim() : "";
      normalized.doi = payload.doi ? String(payload.doi).trim() : "";
      normalized.pmid = payload.pmid ? String(payload.pmid).trim() : "";
      normalized.link = payload.link ? String(payload.link).trim() : "";
      normalized.authors = Array.isArray(payload.authors)
        ? payload.authors
            .map((a) => String(a || "").trim())
            .filter(Boolean)
            .slice(0, 30)
        : [];
      normalized.source = payload.source ? String(payload.source).trim() : "manual";
    } else {
      normalized.trialStatus = payload.trialStatus
        ? String(payload.trialStatus).trim()
        : "";
      normalized.phase = payload.phase ? String(payload.phase).trim() : "";
      normalized.location = payload.location ? String(payload.location).trim() : "";
      normalized.eligibility = payload.eligibility
        ? String(payload.eligibility).trim()
        : "";
      normalized.description = payload.description
        ? String(payload.description).trim()
        : "";
      normalized.contacts = Array.isArray(payload.contacts)
        ? payload.contacts
            .slice(0, 10)
            .map((c) => ({
              name: c?.name ? String(c.name).trim() : "",
              email: c?.email ? String(c.email).trim() : "",
              phone: c?.phone ? String(c.phone).trim() : "",
            }))
        : [];
    }

    const submission = await WorkSubmission.create(normalized);
    res.status(201).json({ ok: true, submission });
  } catch (error) {
    console.error("Error creating work submission:", error);
    res.status(500).json({ error: "Failed to submit work" });
  }
});

export default router;
