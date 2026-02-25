import { Router } from "express";
import {
  summarizeText,
  extractConditions,
  extractExpertInfo,
  generateTrialContactMessage,
  simplifyTitle,
  generateTrialDetails,
  simplifyTrialSummary,
  batchSimplifyPublicationTitles,
} from "../services/summary.service.js";
import { generateSummaryReport } from "../services/summaryReport.service.js";
import { batchSimplifyTrialTitles } from "../services/trialSimplification.service.js";
import { fetchPublicationById } from "../services/urlParser.service.js";

const router = Router();

// Build publication content in same structured form as chatbot (full abstract, keywords) for better summaries
function buildPublicationContentForSummary(pub) {
  const title = pub.title || "Unknown";
  const authors = Array.isArray(pub.authors) ? pub.authors.join(", ") : (pub.authors || "Unknown");
  const journal = pub.journal || "Unknown";
  const year = pub.year || "";
  const abstract = pub.abstract || pub.fullAbstract || "";
  const keywords = Array.isArray(pub.keywords) ? pub.keywords.join(", ") : (pub.keywords || "");
  const parts = [
    `Title: ${title}`,
    `Authors: ${authors}`,
    `Journal: ${journal}${year ? ` (${year})` : ""}`,
    abstract ? `Abstract:\n${abstract}` : "",
    keywords ? `Keywords: ${keywords}` : "",
  ].filter(Boolean);
  return parts.join("\n\n");
}

router.post("/ai/summary", async (req, res) => {
  const { text, type, trial, simplify = false, pmid } = req.body || {};
  const publication = req.body?.publication;

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
        },
      });
      return;
    } catch (error) {
      console.error("Error generating structured trial summary:", error);
      // Fallback to regular summary
    }
  }

  // For publications: when pmid is provided, fetch full publication (same as publication-detail chatbot) for richer summary
  if (type === "publication" && (pmid || publication?.pmid || publication?.id)) {
    const idToFetch = pmid || publication?.pmid || publication?.id;
    try {
      const fullPub = await fetchPublicationById(String(idToFetch));
      if (fullPub) {
        const fullContent = buildPublicationContentForSummary({
          ...publication,
          ...fullPub,
          fullAbstract: fullPub.abstract || publication?.abstract,
          abstract: fullPub.abstract || publication?.abstract,
        });
        const summary = await summarizeText(fullContent, type, simplify);
        return res.json({ summary });
      }
    } catch (err) {
      console.warn("AI summary: fetch by PMID failed, using provided text:", err?.message);
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

router.post("/ai/simplify-trial-summary", async (req, res) => {
  try {
    const { trial } = req.body || {};

    if (!trial) {
      return res.status(400).json({ error: "trial is required" });
    }

    const simplified = await simplifyTrialSummary(trial);
    res.json({ simplifiedSummary: simplified });
  } catch (error) {
    console.error("Error simplifying trial summary:", error);
    res.status(500).json({ error: "Failed to simplify trial summary" });
  }
});

router.post("/ai/batch-simplify-titles", async (req, res) => {
  try {
    const { titles } = req.body || {};

    if (!titles || !Array.isArray(titles)) {
      return res.status(400).json({ error: "titles array is required" });
    }

    const simplifiedTitles = await batchSimplifyPublicationTitles(titles);
    res.json({ simplifiedTitles });
  } catch (error) {
    console.error("Error batch simplifying titles:", error);
    res.status(500).json({ error: "Failed to batch simplify titles" });
  }
});

router.post("/ai/batch-simplify-trial-summaries", async (req, res) => {
  try {
    const { trials } = req.body || {};

    if (!trials || !Array.isArray(trials)) {
      return res.status(400).json({ error: "trials array is required" });
    }

    const simplifiedTitles = await batchSimplifyTrialTitles(trials);
    res.json({ simplifiedSummaries: simplifiedTitles });
  } catch (error) {
    console.error("Error batch simplifying trial summaries:", error);
    res.status(500).json({ error: "Failed to batch simplify trial summaries" });
  }
});

export default router;
