import { Router } from "express";
import {
  summarizeText,
  extractConditions,
  extractExpertInfo,
  generateTrialContactMessage,
  simplifyTitle,
  generateTrialDetails,
} from "../services/summary.service.js";
import { generateSummaryReport } from "../services/summaryReport.service.js";

const router = Router();

router.post("/ai/summary", async (req, res) => {
  const { text, type, trial, simplify = false } = req.body || {};
  
  // For trials, generate structured summary with procedures, risks/benefits, and participant requirements
  if (type === "trial" && trial) {
    try {
      const details = await generateTrialDetails(trial, "all", simplify);
      
      // Also generate a general summary
      const generalSummary = await summarizeText(text || "", type || "general", simplify);
      
      res.json({ 
        summary: {
          structured: true,
          generalSummary: generalSummary,
          procedures: details.procedures,
          risksBenefits: details.risksBenefits,
          participantRequirements: details.participantRequirements,
        }
      });
      return;
    } catch (error) {
      console.error("Error generating structured trial summary:", error);
      // Fallback to regular summary
    }
  }
  
  const summary = await summarizeText(text || "", type || "general", simplify);
  res.json({ summary });
});

router.post("/ai/extract-conditions", async (req, res) => {
  const { text } = req.body || {};
  const conditions = await extractConditions(text || "");
  res.json({ conditions });
});

router.post("/ai/extract-expert-info", async (req, res) => {
  const { biography, name } = req.body || {};
  const info = await extractExpertInfo(biography || "", name || "");
  res.json({ info });
});

router.post("/ai/generate-summary-report", async (req, res) => {
  try {
    const { selectedItems, patientContext } = req.body || {};

    if (!selectedItems) {
      return res.status(400).json({ error: "selectedItems is required" });
    }

    const report = await generateSummaryReport(
      selectedItems,
      patientContext || {}
    );
    res.json({ report });
  } catch (error) {
    console.error("Error generating summary report:", error);
    res.status(500).json({ error: "Failed to generate summary report" });
  }
});

router.post("/ai/generate-trial-message", async (req, res) => {
  try {
    const { userName, userLocation, trial } = req.body || {};

    if (!trial) {
      return res.status(400).json({ error: "trial is required" });
    }

    const message = await generateTrialContactMessage(
      userName || "",
      userLocation || null,
      trial
    );
    res.json({ message });
  } catch (error) {
    console.error("Error generating trial contact message:", error);
    res.status(500).json({ error: "Failed to generate message" });
  }
});

router.post("/ai/simplify-title", async (req, res) => {
  try {
    const { title } = req.body || {};

    if (!title) {
      return res.status(400).json({ error: "title is required" });
    }

    const simplified = await simplifyTitle(title);
    res.json({ simplifiedTitle: simplified });
  } catch (error) {
    console.error("Error simplifying title:", error);
    res.status(500).json({ error: "Failed to simplify title" });
  }
});

router.post("/ai/trial-details", async (req, res) => {
  try {
    const { trial, section } = req.body || {};

    if (!trial) {
      return res.status(400).json({ error: "trial is required" });
    }

    const details = await generateTrialDetails(trial, section || "all");
    res.json({ details });
  } catch (error) {
    console.error("Error generating trial details:", error);
    res.status(500).json({ error: "Failed to generate trial details" });
  }
});

export default router;
