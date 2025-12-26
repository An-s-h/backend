import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;

if (!apiKey) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY not found in environment variables. Gemini expert search will not work."
  );
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;

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
      const isOverloadError =
        error.message?.includes("overloaded") ||
        error.message?.includes("503") ||
        error.status === 503;

      if (isLastAttempt || !isOverloadError) {
        throw error;
      }

      // Exponential backoff: 1s, 2s, 4s
      const delay = initialDelay * Math.pow(2, attempt);
      console.log(
        `Gemini overloaded, retrying in ${delay}ms... (attempt ${
          attempt + 1
        }/${maxRetries})`
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

  try {
    // Use fastest model (flash is much faster than pro)
    // Use fastest and deterministic model
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

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

    const result = await retryWithBackoff(async () => {
      return await model.generateContent(prompt, {
        generationConfig: {
          maxOutputTokens: 3000, // Slightly higher for detail
          temperature: 0.3, // Lower for consistency and factual accuracy
          topP: 0.7,
          topK: 40,
        },
      });
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
    return formattedResearchers;
  } catch (error) {
    console.error("Error finding researchers with Gemini:", error.message);
    if (
      error.message?.includes("overloaded") ||
      error.message?.includes("503")
    ) {
      console.error("Gemini model is overloaded. Please try again later.");
    }
    if (error.message?.includes("JSON")) {
      console.error("Failed to parse JSON response from Gemini");
    }
    return [];
  }
}
