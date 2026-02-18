/**
 * Natural language → search keywords
 * Converts questions/phrases like "what is the benefit of vitamins in cancer"
 * into search-friendly terms: "vitamins cancer" for publications, trials, and experts.
 *
 * Uses rule-based extraction (fast, no API). Optional: can add a single
 * Gemini/Quick AI call later for complex questions if needed.
 */

const QUESTION_AND_FILLER = new Set([
  "what", "is", "are", "was", "were", "the", "a", "an", "of", "in", "on", "at", "to", "for", "with", "by",
  "how", "does", "do", "can", "could", "would", "should", "may", "might", "will", "when", "where", "which", "who", "why",
  "benefit", "benefits", "effect", "effects", "role", "evidence", "about", "related", "regarding", "concerning",
  "between", "among", "during", "into", "from", "than", "that", "this", "and", "or", "but", "if", "as", "it", "its",
  "not", "no", "yes", "just", "only", "also", "even", "so", "such", "there", "their", "them", "then", "been", "being",
  "have", "has", "had", "did", "done", "get", "gets", "got", "need", "needs", "used", "using", "show", "shows",
  "shown", "find", "finding", "found", "help", "helps", "work", "works", "working", "used", "use",
]);

/** Minimum word length to keep (single chars like "c" are noise) */
const MIN_WORD_LEN = 2;

/**
 * Convert natural language query to search keywords.
 * - Strips question words and fillers; keeps medical/topic terms.
 * - If input already looks like keywords (short, no question words), returns as-is.
 * - Preserves multi-word phrases by rejoining kept tokens (e.g. "vitamins in cancer" → "vitamins cancer").
 *
 * @param {string} query - Raw user input (e.g. "what is the benefit of vitamins in cancer")
 * @returns {string} - Keyword string for search (e.g. "vitamins cancer")
 */
export function naturalLanguageToSearchKeywords(query) {
  if (!query || typeof query !== "string") return query;
  const trimmed = query.trim();
  if (!trimmed) return query;

  const words = trimmed.split(/\s+/);
  if (words.length === 0) return query;

  const lowerWords = words.map((w) => w.toLowerCase().replace(/[^\w]/g, ""));
  const fillerCount = lowerWords.filter((w) => QUESTION_AND_FILLER.has(w)).length;

  // Already keyword-style: short and no question/filler words
  if (words.length <= 5 && fillerCount === 0) return trimmed;

  const kept = words.filter((w) => {
    const normalized = w.toLowerCase().replace(/[^\w]/g, "");
    if (normalized.length < MIN_WORD_LEN) return false;
    if (QUESTION_AND_FILLER.has(normalized)) return false;
    return true;
  });

  const result = kept.join(" ").trim();
  return result || trimmed;
}
