import { Router } from "express";
import { summarizeText, extractConditions, extractExpertInfo, generateTrialContactMessage } from "../services/summary.service.js";
import { generateSummaryReport } from "../services/summaryReport.service.js";

const router = Router();

router.post("/ai/summary", async (req, res) => {
  const { text } = req.body || {};
  const summary = await summarizeText(text || "");
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

    const report = await generateSummaryReport(selectedItems, patientContext || {});
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

export default router;


