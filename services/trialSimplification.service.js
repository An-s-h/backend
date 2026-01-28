import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

// Get API keys from environment variables
const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2; // Second API key for load balancing

if (!apiKey && !apiKey2) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY or GOOGLE_AI_API_KEY_2 not found in environment variables. Trial simplification will use fallback."
  );
}

// Create instances for both API keys if available
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

// Round-robin counter for load balancing between API keys
let apiKeyCounter = 0;

// Cache for simplified titles (in-memory)
const titleCache = new Map();
const CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Get the appropriate Gemini instance based on load balancing
 * Uses round-robin to distribute requests between API keys
 */
function getGeminiInstance() {
  if (!genAI && !genAI2) {
    return null;
  }

  // If only one API key is available, use it
  if (!genAI2) {
    return genAI;
  }
  if (!genAI) {
    return genAI2;
  }

  // Round-robin between two API keys
  apiKeyCounter = (apiKeyCounter + 1) % 2;
  return apiKeyCounter === 0 ? genAI : genAI2;
}

/**
 * Simplify just the trial title using AI
 * This is a lightweight function for batch processing titles in search results
 */
export async function simplifyTrialTitle(trial) {
  if (!trial || !trial.title) {
    return trial?.title || "";
  }

  // Skip simplification for short titles (already simple enough)
  if (trial.title.length <= 80) {
    return trial.title;
  }

  // Check cache first
  const cacheKey = trial.title.toLowerCase().trim();
  const cached = titleCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
    return cached.simplifiedTitle;
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original title if AI is not available
    return trial.title;
  }

  try {
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const prompt = `Simplify the following medical research or clinical trial title so that a high school–level reader can understand it easily.

CRITICAL RULES:
- Preserve the original meaning, intent, and medical context exactly
- Do NOT change what is being studied, tested, or measured
- Do NOT add outcomes, conclusions, or assumptions
- Keep key medical conditions, diseases, and treatments, but:
  - You MAY replace highly technical phrasing with commonly understood equivalents
  - You MAY add brief clarifying words if needed (e.g., "a type of cancer")
- Avoid abbreviations unless they are widely known (e.g., HIV, COVID-19)
- Use clear, simple sentence structure
- Remove unnecessary scientific framing (e.g., "A randomized controlled trial of…")

STYLE:
- 10–15 words maximum
- Plain, patient-friendly language
- Neutral and factual tone

Original title:
"${trial.title}"

Return ONLY the simplified title.
No explanations, no quotes, no formatting.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.7,
      },
    });

    let simplifiedTitle = result.response.text().trim();

    // Clean up any quotes or extra formatting
    simplifiedTitle = simplifiedTitle.replace(/^["']|["']$/g, "").trim();

    // If the response is too long or seems wrong, fallback to original
    if (simplifiedTitle.length > 200 || simplifiedTitle.length < 5) {
      simplifiedTitle = trial.title;
    }

    // Cache the result
    titleCache.set(cacheKey, {
      simplifiedTitle,
      timestamp: Date.now(),
    });

    return simplifiedTitle;
  } catch (error) {
    console.error("Error simplifying trial title:", error);
    // Fallback: return original title
    return trial.title;
  }
}

/**
 * Batch simplify multiple trial titles in a single API call
 * This is much faster than calling simplifyTrialTitle individually
 * @param {Array} trials - Array of trial objects with title property
 * @returns {Promise<Array>} - Array of simplified titles in same order
 */
export async function batchSimplifyTrialTitles(trials) {
  if (!trials || trials.length === 0) {
    return [];
  }

  // Filter out trials that don't need simplification
  const trialsToSimplify = trials.filter(
    (trial) => trial && trial.title && trial.title.length > 80
  );

  // If no trials need simplification, return original titles
  if (trialsToSimplify.length === 0) {
    return trials.map((t) => t?.title || "");
  }

  // Check cache for all titles first
  const results = new Map();
  const uncachedTrials = [];

  for (const trial of trialsToSimplify) {
    const cacheKey = trial.title.toLowerCase().trim();
    const cached = titleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_EXPIRY) {
      results.set(trial.title, cached.simplifiedTitle);
    } else {
      uncachedTrials.push(trial);
    }
  }

  // If all were cached, return immediately
  if (uncachedTrials.length === 0) {
    return trials.map((t) => {
      if (!t || !t.title) return "";
      if (t.title.length <= 80) return t.title;
      return results.get(t.title) || t.title;
    });
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original titles
    return trials.map((t) => t?.title || "");
  }

  try {
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    // Build batch prompt with all titles (limit to reasonable size)
    const titlesList = uncachedTrials
      .map((t, i) => `${i + 1}. ${t.title}`)
      .join("\n");

    const prompt = `Simplify the following ${uncachedTrials.length} medical research or clinical trial titles so that a high school–level reader can understand them easily.

CRITICAL RULES:
- Preserve the original meaning, intent, and medical context exactly
- Do NOT change what is being studied, tested, or measured
- Do NOT add outcomes, conclusions, or assumptions
- Keep key medical conditions, diseases, and treatments, but:
  - You MAY replace highly technical phrasing with commonly understood equivalents
  - You MAY add brief clarifying words if needed (e.g., "a type of cancer")
- Avoid abbreviations unless they are widely known (e.g., HIV, COVID-19)
- Use clear, simple sentence structure
- Remove unnecessary scientific framing (e.g., "A randomized controlled trial of…")

STYLE:
- 10–15 words maximum per title
- Plain, patient-friendly language
- Neutral and factual tone

${titlesList}

Return ONLY a numbered list (1-${uncachedTrials.length}), one simplified title per line, in the same order. No quotes, no explanations. Format:
1. [simplified title 1]
2. [simplified title 2]`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: Math.min(50 * uncachedTrials.length, 1500), // Reduced from 100 to 50 per title
        temperature: 0.5, // Reduced from 0.7 for faster, more consistent responses
      },
    });

    let responseText = result.response.text().trim();

    // Parse the numbered list response
    const lines = responseText.split("\n").filter((line) => line.trim());
    const simplifiedTitles = [];

    for (let i = 0; i < uncachedTrials.length; i++) {
      let simplifiedTitle = "";
      
      // Try to find the corresponding line (handle various formats)
      const line = lines.find((l) => {
        const match = l.match(/^\d+[\.\)]\s*(.+)$/);
        if (match) {
          const num = parseInt(l.match(/^\d+/)[0]);
          return num === i + 1;
        }
        return false;
      });

      if (line) {
        const match = line.match(/^\d+[\.\)]\s*(.+)$/);
        simplifiedTitle = match ? match[1].trim() : line.replace(/^\d+[\.\)]\s*/, "").trim();
      } else if (lines[i]) {
        // Fallback: use line by index
        simplifiedTitle = lines[i].replace(/^\d+[\.\)]\s*/, "").trim();
      }

      // Clean up quotes
      simplifiedTitle = simplifiedTitle.replace(/^["']|["']$/g, "").trim();

      // Validate and cache
      if (simplifiedTitle.length > 200 || simplifiedTitle.length < 5) {
        simplifiedTitle = uncachedTrials[i].title;
      }

      const cacheKey = uncachedTrials[i].title.toLowerCase().trim();
      titleCache.set(cacheKey, {
        simplifiedTitle,
        timestamp: Date.now(),
      });

      results.set(uncachedTrials[i].title, simplifiedTitle);
    }

    // Return results in original order
    return trials.map((t) => {
      if (!t || !t.title) return "";
      if (t.title.length <= 80) return t.title;
      return results.get(t.title) || t.title;
    });
  } catch (error) {
    console.error("Error batch simplifying trial titles:", error);
    // Fallback: return original titles
    return trials.map((t) => t?.title || "");
  }
}

/**
 * Simplify trial details using AI to convert complex medical language
 * into high school level plain language
 */
export async function simplifyTrialDetails(trial) {
  if (!trial) {
    return null;
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original trial data if AI is not available
    console.warn("Google AI instance not available, returning original trial data");
    return {
      simplified: false,
      trial: trial,
    };
  }

  // Double-check API keys are available
  if (!apiKey && !apiKey2) {
    console.warn("Google AI API keys not configured, returning original trial data");
    return {
      simplified: false,
      trial: trial,
    };
  }

  try {
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // Build comprehensive trial information for AI processing
    const trialInfo = {
      title: trial.title || "Clinical Trial",
      description: trial.description || "",
      eligibility: {
        criteria: trial.eligibility?.criteria || "",
        gender: trial.eligibility?.gender || "All",
        minimumAge: trial.eligibility?.minimumAge || "Not specified",
        maximumAge: trial.eligibility?.maximumAge || "Not specified",
        healthyVolunteers: trial.eligibility?.healthyVolunteers || "Unknown",
        population: trial.eligibility?.population || "",
      },
      conditions: trial.conditions || [],
      contacts: trial.contacts || [],
      locations: trial.locations || [],
      phase: trial.phase || "N/A",
      status: trial.status || "Unknown",
    };

    const prompt = `You are a medical communication expert. Your task is to simplify this clinical trial information into plain, easy-to-understand language that a high school student could understand. Use simple words, short sentences, and avoid medical jargon.

Return a JSON object with the following structure:
{
  "title": "Simplified version of the trial title in plain language, easy to understand (keep it short, 10-15 words max)",
  "studyPurpose": "Simple explanation of what this study is trying to find out, in 2-3 sentences",
    "eligibilityCriteria": {
    "summary": "Simple explanation of who can join this study, in plain language",
    "gender": "Simple explanation of gender requirements (e.g., 'Men and women' or 'Anyone')",
    "ageRange": "Simple explanation of age requirements (e.g., '18 to 65 years old' or 'Adults 18 and older')",
    "volunteers": "Simple explanation of whether healthy people can join (e.g., 'Yes, healthy people can join' or 'No, only people with the condition can join')",
    "detailedCriteria": "Simplified version of the detailed eligibility criteria. Format as: 'Required criteria to participate in study: [list inclusion criteria in 2-4 concise bullet points or short sentences, keep each point under 50 words]\\n\\nCriteria that might exclude you from the study: [list exclusion criteria in 2-4 concise bullet points or short sentences, keep each point under 50 words]'. If there are no exclusion criteria, only include the inclusion section. Keep the total length reasonable - prioritize clarity and brevity over completeness."
  },
  "conditionsStudied": "Simple explanation of what health conditions or diseases this study is looking at, in plain language",
  "whatToExpect": "Simple explanation of what participants might expect if they join, in 2-3 sentences"
}

IMPORTANT RULES:
- Use everyday language, not medical terms
- If you must use a medical term, explain it in simple words
- Keep sentences short (15-20 words max)
- Use active voice
- Be friendly and encouraging
- Make it feel like you're explaining to a friend, not a doctor

Trial Information:
Title: ${trialInfo.title}
Description: ${trialInfo.description}
Eligibility Criteria: ${trialInfo.eligibility.criteria}
Gender: ${trialInfo.eligibility.gender}
Age Range: ${trialInfo.eligibility.minimumAge} to ${
      trialInfo.eligibility.maximumAge
    }
Healthy Volunteers: ${trialInfo.eligibility.healthyVolunteers}
Study Population: ${trialInfo.eligibility.population}
Conditions: ${trialInfo.conditions.join(", ")}
Phase: ${trialInfo.phase}
Status: ${trialInfo.status}

Return ONLY valid JSON, no markdown formatting, no code blocks.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 2000,
        temperature: 0.7,
      },
    });

    let responseText = result.response.text().trim();

    // Clean up JSON response
    if (responseText.startsWith("```")) {
      responseText = responseText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    // Remove any leading/trailing whitespace or newlines
    responseText = responseText.trim();

    // Try to parse JSON
    let simplifiedData;
    try {
      simplifiedData = JSON.parse(responseText);
    } catch (parseError) {
      console.error("Error parsing AI response:", parseError);
      console.error("Response text:", responseText);
      // Fallback: return original trial data
      return {
        simplified: false,
        trial: trial,
      };
    }

    // Merge simplified data with original trial data
    return {
      simplified: true,
      trial: {
        ...trial,
        simplifiedDetails: {
          title: simplifiedData.title || trial.title || "",
          studyPurpose: simplifiedData.studyPurpose || trial.description || "",
          eligibilityCriteria: {
            summary: simplifiedData.eligibilityCriteria?.summary || "",
            gender:
              simplifiedData.eligibilityCriteria?.gender ||
              trialInfo.eligibility.gender,
            ageRange:
              simplifiedData.eligibilityCriteria?.ageRange ||
              `${trialInfo.eligibility.minimumAge} to ${trialInfo.eligibility.maximumAge}`,
            volunteers:
              simplifiedData.eligibilityCriteria?.volunteers ||
              trialInfo.eligibility.healthyVolunteers,
            detailedCriteria:
              simplifiedData.eligibilityCriteria?.detailedCriteria ||
              trialInfo.eligibility.criteria,
          },
          conditionsStudied:
            simplifiedData.conditionsStudied || trialInfo.conditions.join(", "),
          whatToExpect:
            simplifiedData.whatToExpect ||
            "More information will be provided when you contact the study team.",
        },
      },
    };
  } catch (error) {
    // Enhanced error handling to prevent server crashes
    const errorMessage = error?.message || error?.statusText || "Unknown error";
    const errorStatus = error?.status || error?.statusCode || "N/A";
    
    console.error("Error simplifying trial details:", {
      message: errorMessage,
      status: errorStatus,
      errorDetails: error?.errorDetails || error?.error || error,
      stack: error?.stack,
    });
    
    // If it's a 404 or API error, log it but don't crash
    if (errorStatus === 404 || errorStatus === 401 || errorStatus === 403) {
      console.warn(`Google AI API error (${errorStatus}): ${errorMessage}. Returning original trial data.`);
    }
    
    // Fallback: return original trial data - never crash the server
    return {
      simplified: false,
      trial: trial,
    };
  }
}
