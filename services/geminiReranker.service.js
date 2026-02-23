/**
 * Quick rerank of publication results using Gemini (fast model).
 * Takes the top N results after existing ranking and reorders by relevance to the user query.
 * Kept small (few docs, short text) for low latency and rate-limit friendliness.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import rateLimiter from "../utils/geminiRateLimiter.js";

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2;
const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

let apiKeyCounter = 0;

function getGeminiInstance() {
  if (!genAI && !genAI2) return null;
  if (!genAI2) return genAI;
  if (!genAI) return genAI2;
  apiKeyCounter = (apiKeyCounter + 1) % 2;
  return apiKeyCounter === 0 ? genAI : genAI2;
}

const DEFAULT_MAX_DOCS = 20;
const DEFAULT_MAX_CHARS_PER_DOC = 280;

function truncate(str, max) {
  if (!str || typeof str !== "string") return "";
  const s = str.trim();
  return s.length <= max ? s : s.slice(0, max).trim() + "...";
}

/**
 * Rerank publications by relevance to the user query using Gemini.
 * Only the first maxDocs are sent; they are reordered and prepended to the rest.
 *
 * @param {string} query - User's search query
 * @param {Array<{ title?: string, abstract?: string, [key: string]: any }>} publications - Sorted list (best-first)
 * @param {Object} [opts] - { maxDocs: number, maxDocChars: number }
 * @returns {Promise<Array>} Same publications in reranked order
 */
export async function rerankPublicationsWithGemini(query, publications, opts = {}) {
  const enabled = process.env.PUBLICATION_GEMINI_RERANK_ENABLED === "true";
  if (!enabled || !query || !publications?.length) {
    return publications || [];
  }

  const maxDocs = opts.maxDocs ?? parseInt(process.env.PUBLICATION_GEMINI_RERANK_MAX_DOCS, 10) ?? DEFAULT_MAX_DOCS;
  const maxDocChars = opts.maxDocChars ?? parseInt(process.env.PUBLICATION_GEMINI_RERANK_MAX_CHARS, 10) ?? DEFAULT_MAX_CHARS_PER_DOC;

  const slice = publications.slice(0, maxDocs);
  const rest = publications.slice(maxDocs);

  const docLines = slice.map((p, i) => {
    const title = p.title || "No title";
    const snippet = truncate(p.abstract || "", maxDocChars);
    return `${i + 1}. ${title}${snippet ? "\n   " + snippet : ""}`;
  });

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) return publications;

  const model = geminiInstance.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

  const prompt = `You are a search relevance expert. Given the user's query and a list of research paper titles (and short snippets), output the numbers of the papers in order of relevance to the query. Most relevant first.

User query: "${query.trim().slice(0, 500)}"

Papers (number = index):
${docLines.join("\n\n")}

Reply with ONLY a comma-separated list of numbers in relevance order (e.g. 3, 1, 5, 2, 4). Use each number exactly once. No explanation.`;

  try {
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 200,
            temperature: 0.1,
          },
        });
      },
      "gemini-2.5-flash-lite",
      500 + docLines.length * 20,
    );

    const text = (result.response.text() || "").trim();
    const numbers = text
      .replace(/\s/g, " ")
      .split(/[,;]/)
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => Number.isInteger(n) && n >= 1 && n <= slice.length);

    const seen = new Set();
    const ordered = [];
    for (const n of numbers) {
      if (seen.has(n)) continue;
      seen.add(n);
      ordered.push(slice[n - 1]);
    }
    for (let i = 0; i < slice.length; i++) {
      if (!seen.has(i + 1)) ordered.push(slice[i]);
    }

    return [...ordered, ...rest];
  } catch (err) {
    console.warn("Gemini publication rerank failed:", err?.message);
    return publications;
  }
}
