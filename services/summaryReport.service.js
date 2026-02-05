import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import rateLimiter from "../utils/geminiRateLimiter.js";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

/**
 * Generate expert summary using Gemini AI
 */
export async function generateExpertSummary(expert, patientContext = {}) {
  if (!genAI) {
    // Fallback without AI
    return {
      name: expert.name || "Unknown Expert",
      affiliation:
        expert.affiliation || expert.currentPosition || "Not specified",
      specialty: Array.isArray(expert.specialties)
        ? expert.specialties.join(", ")
        : expert.specialties || "Not specified",
      keyExpertise: Array.isArray(expert.interests)
        ? expert.interests.slice(0, 3).join(", ")
        : "Not specified",
      topPublications: [],
      relevance: "Matches patient condition based on expertise.",
      contact: "Request via CuraLink Admin",
    };
  }

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({ model: modelName });

    const prompt = `
Create a compact clinical profile for this expert.
Return a JSON object with exactly this structure:
{
  "affiliation": "",
  "specialty": "",
  "keyExpertise": "",
  "topPublications": [
    {"title": "", "year": "", "significance": ""},
    {"title": "", "year": "", "significance": ""}
  ],
  "relevance": ""
}

Guidelines:
- Keep all fields concise.
- Do NOT invent affiliations or publications; only summarize what is provided.
- If anything is missing, return "Not specified".

Expert Name: ${expert.name || "Unknown"}
Affiliation: ${expert.affiliation || expert.currentPosition || "Not specified"}
Specialties: ${
      Array.isArray(expert.specialties)
        ? expert.specialties.join(", ")
        : expert.specialties || "Not specified"
    }
Interests: ${
      Array.isArray(expert.interests)
        ? expert.interests.join(", ")
        : expert.interests || "Not specified"
    }
Biography: ${(expert.biography || expert.bio || "").substring(0, 400)}
${
  patientContext.condition
    ? `Patient Condition: ${patientContext.condition}`
    : ""
}

Return ONLY the JSON object with no additional text or commentary.
`;

    const expertDataLength = JSON.stringify(expert).length;
    const estimatedTokens = 200 + expertDataLength / 4 + 500;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt);
      },
      modelName,
      estimatedTokens
    );
    const responseText = result.response.text().trim();

    // Clean JSON response
    let jsonText = responseText;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    const summary = JSON.parse(jsonText);

    return {
      name: expert.name || "Unknown Expert",
      affiliation: summary.affiliation || expert.affiliation || "Not specified",
      specialty:
        summary.specialty ||
        (Array.isArray(expert.specialties)
          ? expert.specialties.join(", ")
          : "Not specified"),
      keyExpertise:
        summary.keyExpertise ||
        (Array.isArray(expert.interests)
          ? expert.interests.slice(0, 3).join(", ")
          : "Not specified"),
      topPublications: summary.topPublications || [],
      relevance:
        summary.relevance || "Matches patient condition based on expertise.",
      contact: "Request via CuraLink Admin",
    };
  } catch (error) {
    console.error("Error generating expert summary:", error);
    // Fallback
    return {
      name: expert.name || "Unknown Expert",
      affiliation:
        expert.affiliation || expert.currentPosition || "Not specified",
      specialty: Array.isArray(expert.specialties)
        ? expert.specialties.join(", ")
        : "Not specified",
      keyExpertise: Array.isArray(expert.interests)
        ? expert.interests.slice(0, 3).join(", ")
        : "Not specified",
      topPublications: [],
      relevance: "Matches patient condition based on expertise.",
      contact: "Request via CuraLink Admin",
    };
  }
}

/**
 * Generate publication summary using Gemini AI
 */
export async function generatePublicationSummary(
  publication,
  patientContext = {}
) {
  // Use DOI as reference number for publications
  const referenceNumber = publication.doi || null;

  // Check if we already have a simplified title
  let displayTitle = publication.simplifiedTitle || null;

  if (!genAI) {
    // Fallback without AI - use existing simplified title or original
    return {
      title: displayTitle || publication.title || "Untitled",
      referenceNumber,
      authors: Array.isArray(publication.authors)
        ? publication.authors.join(", ")
        : publication.authors || "Unknown",
      journal: publication.journal || "Unknown Journal",
      year: publication.year || "Unknown",
      keyFinding: (publication.abstract || "").substring(0, 200) + "...",
      clinicalRelevance: "Relevant to patient condition.",
      evidenceLevel: "Not specified",
    };
  }

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({ model: modelName });

    // Updated prompt to also generate simplified title if needed
    const prompt = `Summarize this medical publication for a doctor. Return a JSON object:
{
  "simplifiedTitle": "A simplified, easy-to-understand version of the title (10-15 words max, plain language a high school student could understand)",
  "keyFinding": "1-2 sentence key finding summary",
  "clinicalRelevance": "What does this mean clinically for the patient?",
  "evidenceLevel": "Case study / Phase 1 / RCT / Meta-analysis / Review / etc."
}

Title: ${publication.title || "Untitled"}
Authors: ${
      Array.isArray(publication.authors)
        ? publication.authors.join(", ")
        : publication.authors || "Unknown"
    }
Journal: ${publication.journal || "Unknown"} (${publication.year || "Unknown"})
Abstract: ${(publication.abstract || "").substring(0, 1000)}
${
  patientContext.condition
    ? `Patient Condition: ${patientContext.condition}`
    : ""
}

Return ONLY valid JSON, no markdown formatting.`;

    const publicationLength = JSON.stringify(publication).length;
    const estimatedTokens = 300 + publicationLength / 4 + 500;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt);
      },
      modelName,
      estimatedTokens
    );
    const responseText = result.response.text().trim();

    let jsonText = responseText;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    const summary = JSON.parse(jsonText);

    // Use existing simplified title, or the AI-generated one, or fall back to original
    const finalTitle = displayTitle || summary.simplifiedTitle || publication.title || "Untitled";

    return {
      title: finalTitle,
      referenceNumber,
      authors: Array.isArray(publication.authors)
        ? publication.authors.join(", ")
        : publication.authors || "Unknown",
      journal: publication.journal || "Unknown Journal",
      year: publication.year || "Unknown",
      keyFinding:
        summary.keyFinding ||
        (publication.abstract || "").substring(0, 200) + "...",
      clinicalRelevance:
        summary.clinicalRelevance || "Relevant to patient condition.",
      evidenceLevel: summary.evidenceLevel || "Not specified",
    };
  } catch (error) {
    console.error("Error generating publication summary:", error);
    // Fallback
    return {
      title: displayTitle || publication.title || "Untitled",
      referenceNumber,
      authors: Array.isArray(publication.authors)
        ? publication.authors.join(", ")
        : publication.authors || "Unknown",
      journal: publication.journal || "Unknown Journal",
      year: publication.year || "Unknown",
      keyFinding: (publication.abstract || "").substring(0, 200) + "...",
      clinicalRelevance: "Relevant to patient condition.",
      evidenceLevel: "Not specified",
    };
  }
}

/**
 * Generate clinical trial summary using Gemini AI
 */
export async function generateTrialSummary(trial, patientContext = {}) {
  // Use NCT ID as reference number for clinical trials
  const referenceNumber = trial.id || trial._id || null;

  // Check if we already have a simplified title
  let displayTitle = trial.simplifiedTitle || trial.simplifiedDetails?.title || null;

  if (!genAI) {
    // Fallback without AI - use existing simplified title or original
    return {
      title: displayTitle || trial.title || "Untitled Trial",
      referenceNumber,
      trialNumber: referenceNumber || "Not specified",
      phase: trial.phase || "Not specified",
      condition: Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "Not specified",
      intervention: trial.intervention || "Not specified",
      location: trial.location || "Not specified",
      status: trial.status || "Unknown",
      eligibilitySnapshot: {
        age: `${trial.eligibility?.minimumAge || "N/A"} - ${
          trial.eligibility?.maximumAge || "N/A"
        }`,
        gender: trial.eligibility?.gender || "All",
        keyInclusion: "See full criteria",
        keyExclusion: "See full criteria",
      },
      goal: trial.description?.substring(0, 200) || "Not specified",
      relevance: "Matches patient condition and eligibility criteria.",
    };
  }

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = genAI.getGenerativeModel({ model: modelName });

    // Updated prompt to also generate simplified title if needed
    const prompt = `Create a doctor-friendly summary of this clinical trial. Return a JSON object:
{
  "simplifiedTitle": "A simplified, easy-to-understand version of the trial title (10-15 words max, plain language a high school student could understand)",
  "intervention": "Main intervention/treatment being tested",
  "eligibilitySnapshot": {
    "age": "Age range (e.g., '18-70')",
    "gender": "Gender requirements",
    "keyInclusion": "1-2 key inclusion criteria",
    "keyExclusion": "1-2 key exclusion criteria"
  },
  "goal": "1-2 sentence goal of the study",
  "relevance": "Why this trial is relevant to the patient (1 sentence)"
}

Title: ${trial.title || "Untitled"}
Phase: ${trial.phase || "Not specified"}
Condition: ${
      Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "Not specified"
    }
Status: ${trial.status || "Unknown"}
Location: ${trial.location || "Not specified"}
Description: ${(trial.description || "").substring(0, 500)}
Eligibility: ${(trial.eligibility?.criteria || "").substring(0, 500)}
${
  patientContext.condition
    ? `Patient Condition: ${patientContext.condition}`
    : ""
}
${patientContext.location ? `Patient Location: ${patientContext.location}` : ""}

Return ONLY valid JSON, no markdown formatting.`;

    const trialLength = JSON.stringify(trial).length;
    const estimatedTokens = 400 + trialLength / 4 + 600;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt);
      },
      modelName,
      estimatedTokens
    );
    const responseText = result.response.text().trim();

    let jsonText = responseText;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    const summary = JSON.parse(jsonText);

    // Use existing simplified title, or the AI-generated one, or fall back to original
    const finalTitle = displayTitle || summary.simplifiedTitle || trial.title || "Untitled Trial";

    return {
      title: finalTitle,
      referenceNumber,
      trialNumber: referenceNumber || "Not specified",
      phase: trial.phase || "Not specified",
      condition: Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "Not specified",
      intervention:
        summary.intervention || trial.intervention || "Not specified",
      location: trial.location || "Not specified",
      status: trial.status || "Unknown",
      eligibilitySnapshot: summary.eligibilitySnapshot || {
        age: `${trial.eligibility?.minimumAge || "N/A"} - ${
          trial.eligibility?.maximumAge || "N/A"
        }`,
        gender: trial.eligibility?.gender || "All",
        keyInclusion: "See full criteria",
        keyExclusion: "See full criteria",
      },
      goal:
        summary.goal || trial.description?.substring(0, 200) || "Not specified",
      relevance:
        summary.relevance ||
        "Matches patient condition and eligibility criteria.",
    };
  } catch (error) {
    console.error("Error generating trial summary:", error);
    // Fallback
    return {
      title: displayTitle || trial.title || "Untitled Trial",
      referenceNumber,
      trialNumber: referenceNumber || "Not specified",
      phase: trial.phase || "Not specified",
      condition: Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "Not specified",
      intervention: trial.intervention || "Not specified",
      location: trial.location || "Not specified",
      status: trial.status || "Unknown",
      eligibilitySnapshot: {
        age: `${trial.eligibility?.minimumAge || "N/A"} - ${
          trial.eligibility?.maximumAge || "N/A"
        }`,
        gender: trial.eligibility?.gender || "All",
        keyInclusion: "See full criteria",
        keyExclusion: "See full criteria",
      },
      goal: trial.description?.substring(0, 200) || "Not specified",
      relevance: "Matches patient condition and eligibility criteria.",
    };
  }
}

/**
 * Generate complete summary report
 */
export async function generateSummaryReport(
  selectedItems,
  patientContext = {}
) {
  const report = {
    patientContext: {
      name: patientContext.name || "Not specified",
      condition: patientContext.condition || "Not specified",
      location: patientContext.location || "Not specified",
      keyConcerns: patientContext.keyConcerns || [],
      interests: patientContext.interests || [],
    },
    experts: [],
    publications: [],
    trials: [],
    generatedAt: new Date().toISOString(),
  };

  // Generate summaries in parallel for better performance
  const expertPromises = selectedItems.experts.map((expert) =>
    generateExpertSummary(expert, patientContext)
  );
  const publicationPromises = selectedItems.publications.map((pub) =>
    generatePublicationSummary(pub, patientContext)
  );
  const trialPromises = selectedItems.trials.map((trial) =>
    generateTrialSummary(trial, patientContext)
  );

  report.experts = await Promise.all(expertPromises);
  report.publications = await Promise.all(publicationPromises);
  report.trials = await Promise.all(trialPromises);

  return report;
}
