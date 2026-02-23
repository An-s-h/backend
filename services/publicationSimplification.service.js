import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import rateLimiter from "../utils/geminiRateLimiter.js";

dotenv.config();

// Get API keys from environment variables
const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2; // Second API key for load balancing

if (!apiKey && !apiKey2) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY or GOOGLE_AI_API_KEY_2 not found in environment variables. Publication simplification will use fallback."
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
 * Simplify just the publication title using AI
 * This is a lightweight function for batch processing titles in search results
 */
export async function simplifyPublicationTitle(publication) {
  if (!publication || !publication.title) {
    return publication?.title || "";
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original title if AI is not available
    return publication.title;
  }

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = geminiInstance.getGenerativeModel({
      model: modelName,
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
"${publication.title}"

Return only the simplified title.
No extra text, no explanations, no quotes.`;

    const estimatedTokens = 150 + (publication.title?.length || 100) / 4 + 100;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 100,
            temperature: 0.7,
          },
        });
      },
      modelName,
      estimatedTokens
    );

    let simplifiedTitle = result.response.text().trim();

    // Clean up any quotes or extra formatting
    simplifiedTitle = simplifiedTitle.replace(/^["']|["']$/g, "").trim();

    // If the response is too long or seems wrong, fallback to original
    if (simplifiedTitle.length > 200 || simplifiedTitle.length < 5) {
      return publication.title;
    }

    return simplifiedTitle;
  } catch (error) {
    console.error("Error simplifying publication title:", error);
    // Fallback: return original title
    return publication.title;
  }
}

/**
 * Simplify publication details using AI.
 * @param {Object} publication - The publication to simplify
 * @param {string} [audience='patient'] - 'patient' = plain language, high school level; 'researcher' = clear, structured, technical terms retained
 */
export async function simplifyPublicationDetails(publication, audience = "patient") {
  if (!publication) {
    return null;
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    // Fallback: return original publication data if AI is not available
    return {
      simplified: false,
      publication: publication,
    };
  }

  const isResearcher = audience === "researcher";

  try {
    const modelName = "gemini-2.5-flash-lite";
    const model = geminiInstance.getGenerativeModel({
      model: modelName,
    });

    // Build comprehensive publication information for AI processing
    const pubInfo = {
      title: publication.title || "Research Publication",
      abstract: publication.abstract || "",
      journal: publication.journal || "",
      authors: Array.isArray(publication.authors)
        ? publication.authors.join(", ")
        : publication.authors || "",
      year: publication.year || "",
      keywords: Array.isArray(publication.keywords)
        ? publication.keywords.join(", ")
        : publication.keywords || "",
    };

    const prompt = isResearcher
      ? `You are a medical research expert. Clarify and structure this research publication for researchers and clinicians. Use appropriate technical terminology, retain key scientific terms, and be concise. Not lay language, but not dense raw text either—strike a balance: clear structure, professional tone, appropriate jargon.

Return a JSON object with the following structure:
{
  "abstract": "Structured summary of the abstract (2-4 sentences). Clarify the research question, design, and main findings using appropriate technical terms.",
  "methods": "Concise description of methodology—design, sample, interventions, endpoints. Use standard research terminology.",
  "results": "Key findings with relevant outcomes, effect sizes, or statistics where applicable.",
  "conclusion": "Clinical/scientific implications and significance (2-3 sentences).",
  "keyTakeaways": "3-5 bullet points summarizing the most important scientific findings. Use professional language.",
  "whatThisMeansForYou": "Brief relevance for clinical practice or future research (2-3 sentences)."
}

RULES: Use technical terminology where appropriate. Be concise. No unnecessary simplification of scientific terms. Professional tone.

Publication Information:
Title: ${pubInfo.title}
Abstract: ${pubInfo.abstract}
Journal: ${pubInfo.journal}
Authors: ${pubInfo.authors}
Year: ${pubInfo.year}
Keywords: ${pubInfo.keywords}

Return ONLY valid JSON, no markdown formatting, no code blocks.`
      : `You are a medical communication expert. Your task is to simplify this research publication information into plain, easy-to-understand language that a high school student could understand. Use simple words, short sentences, and avoid medical jargon.

Return a JSON object with the following structure:
{
  "abstract": "Simplified version of the abstract in plain language, explaining what the study was about and what they found, in 3-4 sentences",
  "methods": "Simple explanation of how the researchers did the study (what they did, who they studied, how long it took), in 2-3 sentences",
  "results": "Simple explanation of what the researchers found (the main findings, what worked, what didn't), in 2-3 sentences",
  "conclusion": "Simple explanation of what this research means and why it matters, in 2-3 sentences",
  "keyTakeaways": "3-5 simple bullet points of the most important things to remember from this research",
  "whatThisMeansForYou": "Simple explanation of how this research might affect patients or people with the condition, in 2-3 sentences"
}

IMPORTANT RULES:
- Use everyday language, not medical or scientific terms
- If you must use a medical term, explain it in simple words immediately after
- Keep sentences short (15-20 words max)
- Use active voice
- Be friendly and encouraging
- Make it feel like you're explaining to a friend, not a scientist
- Break down complex concepts into simple ideas
- Focus on what matters most to regular people

Publication Information:
Title: ${pubInfo.title}
Abstract: ${pubInfo.abstract}
Journal: ${pubInfo.journal}
Authors: ${pubInfo.authors}
Year: ${pubInfo.year}
Keywords: ${pubInfo.keywords}

Return ONLY valid JSON, no markdown formatting, no code blocks.`;

    const pubInfoLength = JSON.stringify(pubInfo).length;
    const estimatedTokens = 400 + pubInfoLength / 4 + 2500;
    
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 2500,
            temperature: 0.7,
          },
        });
      },
      modelName,
      estimatedTokens
    );

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
      // Fallback: return original publication data
      return {
        simplified: false,
        publication: publication,
      };
    }

    // Process keyTakeaways - ensure it's an array
    let keyTakeaways = [];
    if (simplifiedData.keyTakeaways) {
      if (Array.isArray(simplifiedData.keyTakeaways)) {
        keyTakeaways = simplifiedData.keyTakeaways;
      } else if (typeof simplifiedData.keyTakeaways === "string") {
        // Split by newlines or bullets if it's a string
        keyTakeaways = simplifiedData.keyTakeaways
          .split(/\n|•|-\s*/)
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
      }
    }

    // Merge simplified data with original publication data
    return {
      simplified: true,
      publication: {
        ...publication,
        simplifiedDetails: {
          abstract: simplifiedData.abstract || pubInfo.abstract || "",
          methods:
            simplifiedData.methods ||
            "Methods information not available in simplified format.",
          results:
            simplifiedData.results ||
            "Results information not available in simplified format.",
          conclusion:
            simplifiedData.conclusion ||
            "Conclusion information not available in simplified format.",
          keyTakeaways: keyTakeaways.length > 0 ? keyTakeaways : [],
          whatThisMeansForYou:
            simplifiedData.whatThisMeansForYou ||
            "This research may provide insights into the condition or treatment being studied.",
        },
      },
    };
  } catch (error) {
    console.error("Error simplifying publication details:", error);
    // Fallback: return original publication data
    return {
      simplified: false,
      publication: publication,
    };
  }
}
