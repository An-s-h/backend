import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2; // Second API key for load balancing

if (!apiKey && !apiKey2) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY or GOOGLE_AI_API_KEY_2 not found in environment variables. Gemini expert search will not work."
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
  const selectedKey = apiKeyCounter === 0 ? genAI : genAI2;
  return selectedKey;
}

// Cache for query results to reduce API calls
const cache = new Map();
const CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes cache

function getCacheKey(query) {
  return `gemini:experts:${query.toLowerCase().trim()}`;
}

function getCache(key) {
  const item = cache.get(key);
  if (!item) return null;
  if (Date.now() > item.expires) {
    cache.delete(key);
    return null;
  }
  return item.value;
}

function setCache(key, value) {
  cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });

  // Cleanup old cache entries if cache gets too large (prevent memory leaks)
  if (cache.size > 100) {
    const now = Date.now();
    for (const [k, v] of cache.entries()) {
      if (now > v.expires) {
        cache.delete(k);
      }
    }
  }
}

/**
 * Retry helper with exponential backoff
 */
async function retryWithBackoff(fn, maxRetries = 3, initialDelay = 1000) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries - 1;
      const errorMessage = error.message || String(error);
      const errorStatus = error.status || error.statusCode || error.code;
      const isOverloadError =
        errorMessage?.includes("overloaded") ||
        errorMessage?.includes("503") ||
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
        `Gemini ${
          isRateLimitError ? "rate limited" : "overloaded"
        }, retrying in ${delay}ms... (attempt ${attempt + 1}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

/**
 * Use Gemini to find researchers from Google Scholar based on a search query
 * @param {string} query - Search query like "deep brain stimulation in Parkinson's Disease in Toronto Canada"
 * @returns {Promise<Array>} Array of researcher objects with name, bio, university
 */
export async function findResearchersWithGemini(query = "") {
  if (!genAI || !query || !query.trim()) {
    return [];
  }

  // Check cache first
  const cacheKey = getCacheKey(query);
  const cached = getCache(cacheKey);
  if (cached) {
    return cached;
  }

  let geminiInstance = null;
  let attemptWithAlternate = false;

  try {
    geminiInstance = getGeminiInstance(false);
    if (!geminiInstance) {
      console.warn("No Gemini API keys available for expert search");
      return [];
    }

    // Use fastest model (flash is much faster than pro)
    // Use fastest and deterministic model
    let model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash",
    });

    // Highly structured and specific system-style prompt
    const prompt = `
    You are an academic data expert.
    
    Given the topic "${query}", find *real, verifiable researchers* from **Google Scholar** who are highly cited and actively publishing in that field.
    
    You must ensure the researchers match **real Scholar profiles** that contain metrics like:
    - Total citations
    - h-index
    - i10-index
    - Cited-by graph
    - Public access section (articles available)
    
    Use this pattern as a reference of what verified Google Scholar researchers look like:
    Example profile elements:
    Citations: 9128 | h-index: 50 | i10-index: 173
    Cited by graph (2018–2025)
    Public access: 12 not available, 41 available
    
    Your output should include only researchers who have similar verifiable statistics visible on Google Scholar.
    
    Ranking rules:
    1. Highest citations and h-index in the field.
    2. Professors or PIs at top universities or hospitals.
    3. Recent publications (since 2020).
    4. Geographically relevant to the given city/country if provided.
    
    Output STRICTLY in this JSON format (no markdown):
    
    [
      {
        "name": "Full Name",
        "university": "Institution Name",
        "location": "City, Country",
        "citations": "9128",
        "hIndex": "50",
        "i10Index": "173",
        "bio": "2-sentence factual summary of their main research focus and impact.",
        "researchInterests": ["keyword1", "keyword2", "keyword3"],
      }
    ]
    
    Guidelines:
    - Return exactly 6 researchers.
    - Use real, verifiable data only (no invented names or institutions).
    - If uncertain, omit rather than fabricate.
    - Include approximate citation metrics only if publicly available from Google Scholar.
    - Focus on those explicitly researching "${query}" in relation to its disease and context.
    `;

    let result;
    try {
      result = await retryWithBackoff(async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 3000, // Slightly higher for detail
            temperature: 0.3, // Lower for consistency and factual accuracy
            topP: 0.7,
            topK: 40,
          },
        });
      });
    } catch (firstError) {
      // If we have two API keys and first one failed, try the alternate
      if (genAI && genAI2 && !attemptWithAlternate) {
        const errorMessage = firstError.message || String(firstError);
        const isRetryableError =
          errorMessage?.includes("429") ||
          errorMessage?.includes("503") ||
          errorMessage?.includes("rate limit") ||
          errorMessage?.includes("quota") ||
          errorMessage?.includes("overloaded") ||
          firstError.status === 429 ||
          firstError.status === 503;

        if (isRetryableError) {
          attemptWithAlternate = true;
          geminiInstance = getGeminiInstance(true);
          model = geminiInstance.getGenerativeModel({
            model: "gemini-2.5-flash",
          });
          result = await retryWithBackoff(async () => {
            return await model.generateContent(prompt, {
              generationConfig: {
                maxOutputTokens: 3000,
                temperature: 0.3,
                topP: 0.7,
                topK: 40,
              },
            });
          });
        } else {
          throw firstError;
        }
      } else {
        throw firstError;
      }
    }

    const responseText = result.response.text().trim();

    // Clean the response - remove markdown code blocks if present
    let jsonText = responseText;
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }

    // Try to extract JSON array from the response
    const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      jsonText = jsonMatch[0];
    }

    const researchers = JSON.parse(jsonText);

    // Validate and format the results
    if (!Array.isArray(researchers)) {
      console.error("Gemini did not return an array");
      return [];
    }

    const formattedResearchers = researchers
      .filter((r) => r && r.name && r.name.trim())
      .map((r) => ({
        name: r.name?.trim() || "Unknown Researcher",
        biography: r.bio?.trim() || r.biography?.trim() || "",
        affiliation: r.university?.trim() || r.affiliation?.trim() || "Unknown",
        location: r.location?.trim() || "",
        researchInterests: Array.isArray(r.researchInterests)
          ? r.researchInterests.filter(Boolean)
          : [],
        // Additional fields that might be useful
        currentPosition: r.currentPosition || null,
        education: r.education || null,
      }))
      .slice(0, 6); // Limit to 6 researchers to avoid overload

    // Cache the results
    setCache(cacheKey, formattedResearchers);
    // #region agent log
    fetch("http://127.0.0.1:7242/ingest/f1b3fc61-8c8f-48bb-889f-dd932b9156c8", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: "geminiExperts.service.js:237",
        message: "Successfully returned researchers",
        data: { count: formattedResearchers.length },
        timestamp: Date.now(),
        sessionId: "debug-session",
        runId: "run1",
        hypothesisId: "C",
      }),
    }).catch(() => {});
    // #endregion
    return formattedResearchers;
  } catch (error) {
    console.error("Error finding researchers with Gemini:", error.message);
    if (
      error.message?.includes("overloaded") ||
      error.message?.includes("503")
    ) {
      console.error("Gemini model is overloaded. Please try again later.");
    }
    if (
      error.message?.includes("429") ||
      error.message?.includes("rate limit") ||
      error.message?.includes("quota")
    ) {
      console.error(
        "Gemini API rate limit or quota exceeded. Please try again later."
      );
    }
    if (error.message?.includes("JSON")) {
      console.error("Failed to parse JSON response from Gemini");
    }
    return [];
  }
}
