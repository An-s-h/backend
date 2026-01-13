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

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original title if AI is not available
    return trial.title;
  }

  try {
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const prompt = `Simplify this clinical trial title into plain, easy-to-understand language that a high school student could understand. Keep it short (10-15 words max). Use simple words and avoid medical jargon.

Original Title: ${trial.title}

Return ONLY the simplified title, nothing else. No quotes, no explanations, just the simplified title.`;

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
      return trial.title;
    }

    return simplifiedTitle;
  } catch (error) {
    console.error("Error simplifying trial title:", error);
    // Fallback: return original title
    return trial.title;
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
    return {
      simplified: false,
      trial: trial,
    };
  }

  try {
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.0-flash-exp",
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
    "detailedCriteria": "Simplified version of the detailed eligibility criteria, broken into easy-to-read bullet points or short paragraphs"
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
    console.error("Error simplifying trial details:", error);
    // Fallback: return original trial data
    return {
      simplified: false,
      trial: trial,
    };
  }
}
