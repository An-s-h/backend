import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// Load environment variables before creating the instance
dotenv.config();

// Get API key from environment variable
const apiKey = process.env.GOOGLE_AI_API_KEY;

if (!apiKey) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY not found in environment variables. AI features will use fallback."
  );
}

const genAI = new GoogleGenerativeAI(apiKey || "");
export async function summarizeText(text) {
  if (!text) return "";

  // fallback if API key missing
  if (!process.env.GOOGLE_AI_API_KEY) {
    const clean = String(text).replace(/\s+/g, " ").trim();
    const words = clean.split(" ");
    return words.slice(0, 40).join(" ") + (words.length > 40 ? "…" : "");
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const result = await model.generateContent(
      `Summarize the following medical content in 3-4 sentences, focusing on key findings and relevance: ${text}`
    );
    return result.response.text();
  } catch (e) {
    console.error("AI summary error:", e);
    const clean = String(text).replace(/\s+/g, " ").trim();
    const words = clean.split(" ");
    return words.slice(0, 40).join(" ") + (words.length > 40 ? "…" : "");
  }
}

export async function extractConditions(naturalLanguage) {
  if (!naturalLanguage) return [];

  // fallback if API key missing
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    const keywords = ["cancer", "pain", "disease", "syndrome", "infection"];
    return keywords.filter((k) => naturalLanguage.toLowerCase().includes(k));
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    const result = await model.generateContent(
      `Extract specific medical conditions/diseases from this patient description. Convert symptoms to their corresponding medical conditions when appropriate (e.g., "high BP" or "high blood pressure" → "Hypertension", "chest pain" → consider "Heart Disease" or "Angina", "breathing issues" → consider "Asthma" or "COPD", "prostate issues" → consider "Prostate Cancer" if cancer-related). Return ONLY a comma-separated list of condition names (diagnoses), no explanations: "${naturalLanguage}"`
    );
    const text = result.response.text().trim();
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (e) {
    console.error("AI condition extraction error:", e);
    return [];
  }
}

export async function extractExpertInfo(biography, name = "") {
  if (!biography) {
    return {
      education: null,
      age: null,
      yearsOfExperience: null,
      specialties: [],
      achievements: null,
      currentPosition: null,
    };
  }

  // Fallback if API key missing
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    return {
      education: null,
      age: null,
      yearsOfExperience: null,
      specialties: [],
      achievements: null,
      currentPosition: null,
    };
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
    // Truncate biography to 500 chars to speed up AI processing
    const truncatedBio =
      biography.length > 500 ? biography.substring(0, 500) + "..." : biography;

    const prompt = `Extract important information from this researcher's biography. Return a JSON object with the following structure:
{
  "education": "University/institution where they studied (e.g., 'PhD from Harvard University') or null if not found",
  "age": "Estimated age or age range (e.g., '45-50 years' or '45') or null if not found",
  "yearsOfExperience": "Years of experience (e.g., '15 years') or null if not found",
  "specialties": ["array of medical specialties or fields of expertise"],
  "achievements": "Notable achievements, awards, or recognitions or null if not found",
  "currentPosition": "Current job title and institution or null if not found"
}

Biography: "${truncatedBio}"
${name ? `Name: "${name}"` : ""}

Return ONLY valid JSON, no explanations or markdown formatting.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 500, // Limit response size for faster processing
      },
    });
    const responseText = result.response.text().trim();

    // Clean the response - remove markdown code blocks if present
    let jsonText = responseText;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    const extracted = JSON.parse(jsonText);

    return {
      education: extracted.education || null,
      age: extracted.age || null,
      yearsOfExperience: extracted.yearsOfExperience || null,
      specialties: Array.isArray(extracted.specialties)
        ? extracted.specialties
        : [],
      achievements: extracted.achievements || null,
      currentPosition: extracted.currentPosition || null,
    };
  } catch (e) {
    console.error("AI expert info extraction error:", e);
    return {
      education: null,
      age: null,
      yearsOfExperience: null,
      specialties: [],
      achievements: null,
      currentPosition: null,
    };
  }
}

export async function generateTrialContactMessage(
  userName,
  userLocation,
  trial
) {
  // Fallback if API key missing
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    // Fallback message
    const locationText = userLocation
      ? typeof userLocation === "string"
        ? userLocation
        : `${userLocation.city || ""}${
            userLocation.city && userLocation.country ? ", " : ""
          }${userLocation.country || ""}`.trim()
      : "";

    return `Dear Clinical Trial Team,

I am interested in learning more about the clinical trial: ${
      trial.title || "this trial"
    }

Trial ID: ${trial.id || trial._id || "N/A"}
Status: ${trial.status || "N/A"}
${trial.phase ? `Phase: ${trial.phase}` : ""}

${locationText ? `I am located in ${locationText}.` : ""}

Please provide more information about participation requirements and next steps.

Thank you.

Best regards,
${userName || "Patient"}`;
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    // Build location string
    const locationText = userLocation
      ? typeof userLocation === "string"
        ? userLocation
        : `${userLocation.city || ""}${
            userLocation.city && userLocation.country ? ", " : ""
          }${userLocation.country || ""}`.trim()
      : "";

    // Build trial information
    const trialInfo = {
      title: trial.title || "N/A",
      id: trial.id || trial._id || "N/A",
      status: trial.status || "N/A",
      phase: trial.phase || null,
      conditions: Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "N/A",
      description: trial.description || trial.conditionDescription || null,
    };

    const prompt = `Generate a professional and polite message for a patient to contact a clinical trial moderator. 

User Information:
- Name: ${userName || "Patient"}
- Location: ${locationText || "Not specified"}

Trial Information:
- Title: ${trialInfo.title}
- Trial ID: ${trialInfo.id}
- Status: ${trialInfo.status}
${trialInfo.phase ? `- Phase: ${trialInfo.phase}` : ""}
- Conditions: ${trialInfo.conditions}
${
  trialInfo.description
    ? `- Description: ${trialInfo.description.substring(0, 300)}`
    : ""
}

Generate a concise, professional message (3-4 paragraphs) that:
1. Introduces the user and their location
2. Expresses interest in the specific trial
3. Mentions relevant trial details (ID, status, phase if available)
4. Requests information about participation requirements and next steps
5. Ends politely

Return ONLY the message text, no explanations or markdown formatting.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 500,
        temperature: 0.7,
      },
    });

    return result.response.text().trim();
  } catch (e) {
    console.error("AI message generation error:", e);
    // Fallback message
    const locationText = userLocation
      ? typeof userLocation === "string"
        ? userLocation
        : `${userLocation.city || ""}${
            userLocation.city && userLocation.country ? ", " : ""
          }${userLocation.country || ""}`.trim()
      : "";

    return `Dear Clinical Trial Team,

I am interested in learning more about the clinical trial: ${
      trial.title || "this trial"
    }

Trial ID: ${trial.id || trial._id || "N/A"}
Status: ${trial.status || "N/A"}
${trial.phase ? `Phase: ${trial.phase}` : ""}

${locationText ? `I am located in ${locationText}.` : ""}

Please provide more information about participation requirements and next steps.

Thank you.

Best regards,
${userName || "Patient"}`;
  }
}
