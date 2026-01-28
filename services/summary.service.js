import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// Load environment variables before creating the instance
dotenv.config();

// Get API keys from environment variables
const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2; // Second API key for load balancing

if (!apiKey) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY not found in environment variables. AI features will use fallback."
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
 * @param {boolean} preferAlternate - If true, use the alternate key (for fallback)
 */
function getGeminiInstance(preferAlternate = false) {
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

  // If preferAlternate is true, use the alternate key (for fallback on error)
  if (preferAlternate) {
    const alternateKey = apiKeyCounter === 0 ? genAI2 : genAI;
    return alternateKey;
  }

  // Round-robin between two API keys
  apiKeyCounter = (apiKeyCounter + 1) % 2;
  return apiKeyCounter === 0 ? genAI : genAI2;
}

/**
 * Retry helper with exponential backoff and API key fallback
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;
      const errorMessage = error.message || String(error);
      // Check multiple possible locations for status code
      const errorStatus = error.status || error.statusCode || error.code || 
                         (error.response?.status) || 
                         (error.errorDetails?.status);
      const isOverloadError =
        errorMessage?.includes("overloaded") ||
        errorMessage?.includes("503") ||
        errorMessage?.includes("Service Unavailable") ||
        errorStatus === 503;
      const isRateLimitError = 
        errorMessage?.includes("429") ||
        errorMessage?.includes("rate limit") ||
        errorMessage?.includes("quota") ||
        errorMessage?.includes("exceeded") ||
        errorStatus === 429;

      if (isLastAttempt || (!isOverloadError && !isRateLimitError)) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `Gemini ${isRateLimitError ? 'rate limited' : 'overloaded'}, retrying in ${delay}ms... (attempt ${
          attempt + 1
        }/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
export async function summarizeText(text, type = "general", simplify = false) {
  if (!text)
    return type === "publication" ? { structured: false, summary: "" } : "";

  // fallback if API key missing
  if (!process.env.GOOGLE_AI_API_KEY) {
    const clean = String(text).replace(/\s+/g, " ").trim();
    const words = clean.split(" ");
    const fallback =
      words.slice(0, 40).join(" ") + (words.length > 40 ? "…" : "");
    return type === "publication"
      ? { structured: false, summary: fallback }
      : fallback;
  }

  let geminiInstance = null;
  let attemptWithAlternate = false;
  let modelName = "gemini-2.5-flash-lite"; // Default model, can fallback to gemini-2.5-flash
  
  try {
    geminiInstance = getGeminiInstance(false);
    if (!geminiInstance) {
      // Fallback if no API keys available
      const clean = String(text).replace(/\s+/g, " ").trim();
      const words = clean.split(" ");
      const fallback =
        words.slice(0, 40).join(" ") + (words.length > 40 ? "…" : "");
      return type === "publication"
        ? { structured: false, summary: fallback }
        : fallback;
    }

    // Try gemini-2.5-flash-lite first, but can fallback to gemini-2.5-flash if overloaded
    let model = geminiInstance.getGenerativeModel({
      model: modelName,
    });

    // For publications, generate structured summary
    if (type === "publication") {
      const languageInstruction = simplify
        ? "You are explaining medical research to a patient. Use very simple, everyday words. Avoid medical jargon completely. If you must use a medical term, explain it in simple words. Use short sentences. Keep it friendly and easy to understand."
        : "Summarize this research publication for researchers and medical professionals. Use appropriate technical terminology and research language.";

      const prompt = simplify
        ? `You are explaining medical research to a patient in simple, friendly language. ${languageInstruction}

Structure your response as a JSON object with these sections. Write each section as if talking to a friend, using everyday words:

{
  "coreMessage": "The most important finding in 1-2 very simple sentences (what they discovered). Use words like 'found that', 'discovered', 'learned'. Avoid complex terms.",
  "what": "What the study was about - explain the main question or problem in 2-3 simple sentences. Use everyday language. Example: 'They wanted to see if...' instead of 'They investigated whether...'",
  "why": "Why this research matters - explain why this is important in 2-3 simple sentences. Connect it to how it might help people. Use words like 'This is important because...'",
  "how": "How they did the study - describe what they did in 2-3 simple sentences. Use simple words like 'they gave', 'they tested', 'they compared'. Avoid terms like 'administered', 'assessed', 'evaluated'.",
  "soWhat": "What this means for you - explain how this might matter to patients in 2-3 simple sentences. Use words like 'This means...', 'This could help...', 'If you have...'",
  "keyTakeaway": "One simple sentence that's easy to remember. Write it like you're giving advice to a friend."
}

Publication content: ${text.substring(0, 2000)}

IMPORTANT: Use only simple, everyday words. Replace medical terms with plain language. Keep sentences short. Return ONLY valid JSON, no markdown formatting.`
        : `You are a medical research expert. Summarize this research publication for researchers and medical professionals. Use appropriate technical terminology and research language. Structure your response as a JSON object with these sections:

{
  "coreMessage": "The most important finding in 1-2 sentences (what they discovered)",
  "what": "What the study was about - describe the research question/problem (2-3 sentences)",
  "why": "Why this research matters - explain the importance and context (2-3 sentences)",
  "how": "How they did the study - describe the methods (2-3 sentences)",
  "soWhat": "So what does this mean? - explain relevance, implications, and significance (2-3 sentences)",
  "keyTakeaway": "One sentence takeaway that should be remembered"
}

Publication content: ${text.substring(0, 2000)}

Return ONLY valid JSON, no markdown formatting. Use appropriate technical and scientific terminology.`;

      let result;
      try {
        result = await retryWithBackoff(async () => {
          return await model.generateContent(prompt);
        });
    } catch (firstError) {
      // If we have two API keys and first one failed, try the alternate
      if (genAI && genAI2 && !attemptWithAlternate) {
        const errorMessage = firstError.message || String(firstError);
        const errorStatus = firstError.status || firstError.statusCode || firstError.code ||
                           (firstError.response?.status) || (firstError.errorDetails?.status);
        const isRetryableError = 
          errorMessage?.includes("429") ||
          errorMessage?.includes("503") ||
          errorMessage?.includes("rate limit") ||
          errorMessage?.includes("quota") ||
          errorMessage?.includes("overloaded") ||
          errorMessage?.includes("Service Unavailable") ||
          errorStatus === 429 ||
          errorStatus === 503;
        
        if (isRetryableError) {
          attemptWithAlternate = true;
          geminiInstance = getGeminiInstance(true);
          // Try alternate model if flash-lite is overloaded
          const alternateModelName = modelName === "gemini-2.5-flash-lite" ? "gemini-2.5-flash" : "gemini-2.5-flash-lite";
          model = geminiInstance.getGenerativeModel({
            model: alternateModelName,
          });
          result = await retryWithBackoff(async () => {
            return await model.generateContent(prompt);
          });
        } else {
          throw firstError;
        }
      } else {
        throw firstError;
      }
    }
      
      let responseText = result.response.text().trim();

      // Clean markdown if present
      if (responseText.startsWith("```")) {
        responseText = responseText
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g, "")
          .trim();
      }

      try {
        const structured = JSON.parse(responseText);
        return { structured: true, ...structured };
      } catch (parseError) {
        // If JSON parsing fails, return as plain text
        return { structured: false, summary: responseText };
      }
    }

    // For trials and general summaries
    const languageInstruction = simplify
      ? "You are explaining medical information to a patient. Use very simple, everyday words. Avoid medical jargon. Keep sentences short (max 15 words each). Write 3-4 friendly sentences that focus on what matters most to patients. Use words like 'they found', 'this means', 'you might' instead of technical terms."
      : "Summarize the following medical content in 3-4 sentences using appropriate technical and scientific terminology for researchers. Focus on key findings, methodology, and clinical relevance.";

    let result;
    try {
      result = await retryWithBackoff(async () => {
        return await model.generateContent(
          `${languageInstruction}: ${text}`
        );
      });
    } catch (firstError) {
      // If we have two API keys and first one failed, try the alternate
      if (genAI && genAI2 && !attemptWithAlternate) {
        const errorMessage = firstError.message || String(firstError);
        const errorStatus = firstError.status || firstError.statusCode || firstError.code ||
                           (firstError.response?.status) || (firstError.errorDetails?.status);
        const isRetryableError = 
          errorMessage?.includes("429") ||
          errorMessage?.includes("503") ||
          errorMessage?.includes("rate limit") ||
          errorMessage?.includes("quota") ||
          errorMessage?.includes("overloaded") ||
          errorMessage?.includes("Service Unavailable") ||
          errorStatus === 429 ||
          errorStatus === 503;
        
        if (isRetryableError) {
          attemptWithAlternate = true;
          geminiInstance = getGeminiInstance(true);
          // Try alternate model if flash-lite is overloaded
          const alternateModelName = modelName === "gemini-2.5-flash-lite" ? "gemini-2.5-flash" : "gemini-2.5-flash-lite";
          model = geminiInstance.getGenerativeModel({
            model: alternateModelName,
          });
          result = await retryWithBackoff(async () => {
            return await model.generateContent(
              `${languageInstruction}: ${text}`
            );
          });
        } else {
          throw firstError;
        }
      } else {
        throw firstError;
      }
    }
    
    return result.response.text();
  } catch (e) {
    console.error("AI summary error:", e);
    const clean = String(text).replace(/\s+/g, " ").trim();
    const words = clean.split(" ");
    const fallback =
      words.slice(0, 40).join(" ") + (words.length > 40 ? "…" : "");
    return type === "publication"
      ? { structured: false, summary: fallback }
      : fallback;
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
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback if no API keys available
      const keywords = ["cancer", "pain", "disease", "syndrome", "infection"];
      return keywords.filter((k) => naturalLanguage.toLowerCase().includes(k));
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });
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
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback if no API keys available
      return {
        education: null,
        age: null,
        yearsOfExperience: null,
        specialties: [],
        achievements: null,
        currentPosition: null,
      };
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });
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

export async function simplifyTitle(title) {
  if (!title || typeof title !== "string") {
    return title || "";
  }

  // If title is already short (less than 60 characters), return as is
  if (title.length <= 60) {
    return title;
  }

  // Check if any API key is available
  if (!apiKey && !apiKey2) {
    const words = title.split(" ");
    if (words.length <= 10) {
      return title;
    }
    // Return first 10 words with ellipsis
    return words.slice(0, 10).join(" ") + "...";
  }

  try {
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback if no API keys available - just truncate
      const words = title.split(" ");
      if (words.length <= 10) {
        return title;
      }
      return words.slice(0, 10).join(" ") + "...";
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    const prompt = `Rewrite this medical research or clinical trial title so a normal patient (high school level) can easily understand it.

Rules:
- Keep the meaning exactly the same
- Do not change what the study or trial is about
- Do not add results, conclusions, or opinions
- Keep important disease names, conditions, and treatments
- If the wording is too technical, replace it with simpler, commonly used words
- You may add a short explanation if it helps understanding
- Avoid short forms unless they are very common (like HIV or COVID)
- Remove unnecessary scientific phrases

Style:
- 10 to 15 words only
- Simple, clear, patient-friendly language
- Neutral and factual tone

Original title:
"${title}"

Return only the simplified title.
No extra text, no explanations, no quotes.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 100,
        temperature: 0.3, // Lower temperature for more consistent results
      },
    });

    let simplified = result.response.text().trim();

    // Clean up common AI artifacts
    simplified = simplified
      .replace(/^["']|["']$/g, "") // Remove surrounding quotes
      .replace(/^Simplified[:\s]*/i, "")
      .replace(/^Title[:\s]*/i, "")
      .trim();

    // Fallback if result is too long or empty
    if (!simplified || simplified.length > title.length) {
      const words = title.split(" ");
      return words.length <= 12 ? title : words.slice(0, 12).join(" ") + "...";
    }

    return simplified;
  } catch (e) {
    console.error("AI title simplification error:", e);
    // Fallback: truncate intelligently
    const words = title.split(" ");
    if (words.length <= 12) {
      return title;
    }
    return words.slice(0, 12).join(" ") + "...";
  }
}

// Cache for simplified publication titles (in-memory)
const publicationTitleCache = new Map();
const PUBLICATION_CACHE_EXPIRY = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Batch simplify multiple publication titles in a single API call
 * This is much faster than calling simplifyTitle individually
 * @param {Array} titles - Array of title strings
 * @returns {Promise<Array>} - Array of simplified titles in same order
 */
export async function batchSimplifyPublicationTitles(titles) {
  if (!titles || titles.length === 0) {
    return [];
  }

  // Filter out titles that don't need simplification
  const titlesToSimplify = titles.filter(
    (title) => title && typeof title === "string" && title.length > 60
  );

  // If no titles need simplification, return original titles
  if (titlesToSimplify.length === 0) {
    return titles.map((t) => t || "");
  }

  // Check cache for all titles first
  const results = new Map();
  const uncachedTitles = [];

  for (const title of titlesToSimplify) {
    const cacheKey = title.toLowerCase().trim();
    const cached = publicationTitleCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < PUBLICATION_CACHE_EXPIRY) {
      results.set(title, cached.simplifiedTitle);
    } else {
      uncachedTitles.push(title);
    }
  }

  // If all were cached, return immediately
  if (uncachedTitles.length === 0) {
    return titles.map((t) => {
      if (!t || typeof t !== "string") return "";
      if (t.length <= 60) return t;
      return results.get(t) || t;
    });
  }

  // Check if any API key is available
  if (!apiKey && !apiKey2) {
    // Fallback: return original titles with truncation
    return titles.map((t) => {
      if (!t || typeof t !== "string") return "";
      if (t.length <= 60) return t;
      const words = t.split(" ");
      return words.length <= 12 ? t : words.slice(0, 12).join(" ") + "...";
    });
  }

  try {
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback: return original titles with truncation
      return titles.map((t) => {
        if (!t || typeof t !== "string") return "";
        if (t.length <= 60) return t;
        const words = t.split(" ");
        return words.length <= 12 ? t : words.slice(0, 12).join(" ") + "...";
      });
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    // Build batch prompt with all titles (limit to reasonable size)
    const titlesList = uncachedTitles
      .map((t, i) => `${i + 1}. ${t}`)
      .join("\n");

    const prompt = `Rewrite the following ${uncachedTitles.length} medical research or clinical trial titles so a normal patient (high school level) can easily understand them.

Rules:
- Keep the meaning exactly the same
- Do not change what the study or trial is about
- Do not add results, conclusions, or opinions
- Keep important disease names, conditions, and treatments
- If the wording is too technical, replace it with simpler, commonly used words
- You may add a short explanation if it helps understanding
- Avoid short forms unless they are very common (like HIV or COVID)
- Remove unnecessary scientific phrases

Style:
- 10 to 15 words only per title
- Simple, clear, patient-friendly language
- Neutral and factual tone

${titlesList}

Return ONLY a numbered list (1-${uncachedTitles.length}), one simplified title per line, in the same order. No quotes, no explanations. Format:
1. [simplified title 1]
2. [simplified title 2]`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: Math.min(50 * uncachedTitles.length, 1500),
        temperature: 0.3,
      },
    });

    let responseText = result.response.text().trim();

    // Parse the numbered list response
    const lines = responseText.split("\n").filter((line) => line.trim());
    const simplifiedTitles = [];

    for (let i = 0; i < uncachedTitles.length; i++) {
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
        simplifiedTitle = match
          ? match[1].trim()
          : line.replace(/^\d+[\.\)]\s*/, "").trim();
      } else if (lines[i]) {
        // Fallback: use line by index
        simplifiedTitle = lines[i].replace(/^\d+[\.\)]\s*/, "").trim();
      }

      // Clean up quotes
      simplifiedTitle = simplifiedTitle.replace(/^["']|["']$/g, "").trim();

      // Validate and cache
      if (
        !simplifiedTitle ||
        simplifiedTitle.length > uncachedTitles[i].length ||
        simplifiedTitle.length < 5
      ) {
        simplifiedTitle = uncachedTitles[i];
      }

      const cacheKey = uncachedTitles[i].toLowerCase().trim();
      publicationTitleCache.set(cacheKey, {
        simplifiedTitle,
        timestamp: Date.now(),
      });

      results.set(uncachedTitles[i], simplifiedTitle);
    }

    // Return results in original order
    return titles.map((t) => {
      if (!t || typeof t !== "string") return "";
      if (t.length <= 60) return t;
      return results.get(t) || t;
    });
  } catch (error) {
    console.error("Error batch simplifying publication titles:", error);
    // Fallback: return original titles with truncation
    return titles.map((t) => {
      if (!t || typeof t !== "string") return "";
      if (t.length <= 60) return t;
      const words = t.split(" ");
      return words.length <= 12 ? t : words.slice(0, 12).join(" ") + "...";
    });
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
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback message if no API keys available
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

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

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

/**
 * Generate detailed trial information (procedures, risks/benefits, participant requirements)
 */
export async function generateTrialDetails(
  trial,
  section = "all",
  simplify = false
) {
  // Check if any API key is available
  if (!apiKey && !apiKey2) {
    return {
      procedures:
        "Detailed information about study procedures, schedule, and treatments is available on the ClinicalTrials.gov website.",
      risksBenefits:
        "Information about potential risks and benefits associated with this clinical trial is available on the ClinicalTrials.gov website. Please review this information carefully before deciding to participate.",
      participantRequirements:
        "Specific requirements and expectations for participants, including visits, tests, and follow-up procedures, are detailed on the ClinicalTrials.gov website.",
    };
  }

  try {
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback if no API keys available
      return {
        procedures:
          "Detailed information about study procedures, schedule, and treatments is available on the ClinicalTrials.gov website.",
        risksBenefits:
          "Information about potential risks and benefits associated with this clinical trial is available on the ClinicalTrials.gov website. Please review this information carefully before deciding to participate.",
        participantRequirements:
          "Specific requirements and expectations for participants, including visits, tests, and follow-up procedures, are detailed on the ClinicalTrials.gov website.",
      };
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    // Build trial information
    const trialInfo = {
      title: trial.title || "N/A",
      id: trial.id || trial._id || "N/A",
      status: trial.status || "N/A",
      phase: trial.phase || "N/A",
      conditions: Array.isArray(trial.conditions)
        ? trial.conditions.join(", ")
        : trial.conditions || "N/A",
      description: trial.description || trial.conditionDescription || "",
      eligibility: trial.eligibility?.criteria || "",
      location: trial.location || "Not specified",
    };

    // Determine which sections to generate
    const sectionsToGenerate =
      section === "all"
        ? ["procedures", "risksBenefits", "participantRequirements"]
        : [section];

    const result = {};

    // Generate procedures, schedule, and treatments
    if (sectionsToGenerate.includes("procedures")) {
      const languageInstruction = simplify
        ? `explain what happens during this trial in very simple, friendly language. 
- Use everyday words only (say "you will get" instead of "you will receive", "visit" instead of "appointment", "medicine" instead of "medication")
- Keep sentences short (max 15 words each)
- Explain what will happen step by step in simple terms
- Use words like "you", "we", "the team" to make it friendly
- Write 3-4 sentences that are easy to understand`
        : "explain what happens during this trial - including procedures, schedule, and treatments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences)";

      const proceduresPrompt = simplify
        ? `You are explaining a clinical trial to a patient in very simple, friendly language. Based on the clinical trial information provided, explain what happens during this trial in very simple, friendly language. Use everyday words only (say "you will get" instead of "you will receive", "visit" instead of "appointment", "medicine" instead of "medication"). Keep sentences short (max 15 words each). Explain what will happen step by step in simple terms. Use words like "you", "we", "the team" to make it friendly. Write 3-4 sentences that are easy to understand. If specific details are not available, provide a general explanation based on the trial phase and type.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}
- Eligibility: ${trialInfo.eligibility.substring(0, 300)}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`
        : `You are a medical research expert. Based on the clinical trial information provided, explain what happens during this trial - including procedures, schedule, and treatments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences). If specific details are not available, provide a general explanation based on the trial phase and type.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}
- Eligibility: ${trialInfo.eligibility.substring(0, 300)}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`;

      const proceduresResult = await model.generateContent(proceduresPrompt, {
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.7,
        },
      });
      result.procedures = proceduresResult.response.text().trim();
    }

    // Generate risks and benefits
    if (sectionsToGenerate.includes("risksBenefits")) {
      const languageInstruction = simplify
        ? `explain the possible good and bad things about this trial in very simple, friendly language.
- Use simple words (say "might help" instead of "potentially beneficial", "could have side effects" instead of "adverse events")
- Be honest and clear but not scary
- Use short sentences (max 15 words each)
- Explain both what's good about it and what to watch out for
- Write 3-4 sentences that are easy to understand`
        : "explain the potential risks and benefits of participating in this clinical trial. Write this for researchers using appropriate technical terminology and clinical language (3-4 sentences)";

      const risksBenefitsPrompt = simplify
        ? `You are explaining a clinical trial to a patient in very simple, friendly language. Based on the clinical trial information provided, explain the possible good and bad things about this trial in very simple, friendly language. Use simple words (say "might help" instead of "potentially beneficial", "could have side effects" instead of "adverse events"). Be honest and clear but not scary. Use short sentences (max 15 words each). Explain both what's good about it and what to watch out for. Write 3-4 sentences that are easy to understand. Be balanced and informative.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`
        : `You are a medical research expert. Based on the clinical trial information provided, explain the potential risks and benefits of participating in this clinical trial. Write this for researchers using appropriate technical terminology and clinical language (3-4 sentences). Be balanced and informative.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`;

      const risksBenefitsResult = await model.generateContent(
        risksBenefitsPrompt,
        {
          generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.7,
          },
        }
      );
      result.risksBenefits = risksBenefitsResult.response.text().trim();
    }

    // Generate participant requirements
    if (sectionsToGenerate.includes("participantRequirements")) {
      const languageInstruction = simplify
        ? `explain what you need to do if you join this trial in very simple, friendly language.
- Use simple words (say "you'll need to visit" instead of "you'll be required to attend", "they'll test" instead of "they'll conduct assessments")
- Explain visits, tests, and what your time commitment might be
- Keep sentences short (max 15 words each)
- Use friendly language ("you'll", "the team will", "you might need to")
- Write 3-4 sentences that are easy to understand`
        : "explain what participants need to do - including visits, tests, follow-up procedures, and time commitments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences)";

      const requirementsPrompt = simplify
        ? `You are explaining a clinical trial to a patient in very simple, friendly language. Based on the clinical trial information provided, explain what you need to do if you join this trial in very simple, friendly language. Use simple words (say "you'll need to visit" instead of "you'll be required to attend", "they'll test" instead of "they'll conduct assessments"). Explain visits, tests, and what your time commitment might be. Keep sentences short (max 15 words each). Use friendly language ("you'll", "the team will", "you might need to"). Write 3-4 sentences that are easy to understand.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}
- Eligibility: ${trialInfo.eligibility.substring(0, 300)}
- Location: ${trialInfo.location}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`
        : `You are a medical research expert. Based on the clinical trial information provided, explain what participants need to do - including visits, tests, follow-up procedures, and time commitments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences).

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}
- Eligibility: ${trialInfo.eligibility.substring(0, 300)}
- Location: ${trialInfo.location}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`;

      const requirementsResult = await model.generateContent(
        requirementsPrompt,
        {
          generationConfig: {
            maxOutputTokens: 300,
            temperature: 0.7,
          },
        }
      );
      result.participantRequirements = requirementsResult.response
        .text()
        .trim();
    }

    return result;
  } catch (e) {
    console.error("AI trial details generation error:", e);
    // Fallback
    return {
      procedures:
        "Detailed information about study procedures, schedule, and treatments is available on the ClinicalTrials.gov website.",
      risksBenefits:
        "Information about potential risks and benefits associated with this clinical trial is available on the ClinicalTrials.gov website. Please review this information carefully before deciding to participate.",
      participantRequirements:
        "Specific requirements and expectations for participants, including visits, tests, and follow-up procedures, are detailed on the ClinicalTrials.gov website.",
    };
  }
}

/**
 * Simplify trial title/description for display in patient dashboard
 * Similar to simplifyTitle but optimized for clinical trials
 */
export async function simplifyTrialSummary(trial) {
  if (!trial || !trial.title) {
    return trial?.title || "";
  }

  const title = trial.title;

  // If title is already short (less than 80 characters), return as is
  if (title.length <= 80) {
    return title;
  }

  // Check if any API key is available
  if (!apiKey && !apiKey2) {
    // Fallback - just truncate
    const words = title.split(" ");
    if (words.length <= 15) {
      return title;
    }
    return words.slice(0, 15).join(" ") + "...";
  }

  try {
    const geminiInstance = getGeminiInstance();
    if (!geminiInstance) {
      // Fallback if no API keys available
      const words = title.split(" ");
      if (words.length <= 15) {
        return title;
      }
      return words.slice(0, 15).join(" ") + "...";
    }

    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash-lite",
    });

    // Build context from trial information
    const trialContext = [
      trial.status ? `Status: ${trial.status}` : "",
      trial.phase ? `Phase: ${trial.phase}` : "",
      Array.isArray(trial.conditions) && trial.conditions.length > 0
        ? `Conditions: ${trial.conditions.slice(0, 3).join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(". ");

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

${trialContext ? `Context: ${trialContext}\n` : ""}Original title:
"${title}"

Return ONLY the simplified title.
No explanations, no quotes, no formatting.`;

    const result = await model.generateContent(prompt, {
      generationConfig: {
        maxOutputTokens: 150,
        temperature: 0.3, // Lower temperature for more consistent results
      },
    });

    let simplified = result.response.text().trim();

    // Clean up common AI artifacts
    simplified = simplified
      .replace(/^["']|["']$/g, "") // Remove surrounding quotes
      .replace(/^Simplified[:\s]*/i, "")
      .replace(/^Title[:\s]*/i, "")
      .replace(/^Trial[:\s]*/i, "")
      .trim();

    // Fallback if result is too long or empty
    if (!simplified || simplified.length > title.length + 20) {
      const words = title.split(" ");
      return words.length <= 15 ? title : words.slice(0, 15).join(" ") + "...";
    }

    return simplified;
  } catch (e) {
    console.error("AI trial summary simplification error:", e);
    // Fallback: truncate intelligently
    const words = title.split(" ");
    if (words.length <= 15) {
      return title;
    }
    return words.slice(0, 15).join(" ") + "...";
  }
}
