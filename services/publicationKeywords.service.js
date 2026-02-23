/**
 * Publication search keywords: extract from user query using Gemini (fast model) + MeSH.
 * Supports question-type detection (etiology, screening, treatment, diagnosis, prognosis, prevention)
 * and stopword filtering for accurate results.
 * Used when USE_ATM_V2_PUBLICATIONS=true to drive multi-source publication search.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import rateLimiter from "../utils/geminiRateLimiter.js";
import {
  mapToMeSHTerminology,
  expandQueryWithSynonyms,
} from "./medicalTerminology.service.js";

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "not",
  "of",
  "in",
  "for",
  "to",
  "with",
  "on",
  "at",
  "by",
  "from",
  "what",
  "is",
  "are",
  "does",
  "do",
  "can",
  "could",
  "should",
  "would",
  "how",
  "why",
  "when",
  "vs",
  "versus",
  "about",
  "overall",
  "general",
]);

const QUESTION_TYPES = [
  {
    name: "etiology_risk",
    triggers: [
      "risk",
      "risk factors",
      "incidence",
      "epidemiology",
      "prevalence",
      "odds ratio",
      "hazard ratio",
      "relative risk",
    ],
  },
  {
    name: "screening",
    triggers: [
      "screening",
      "early detection",
      "sensitivity",
      "specificity",
      "false positive",
      "false negative",
    ],
  },
  {
    name: "treatment",
    triggers: [
      "treat",
      "treatment",
      "therapy",
      "drug",
      "intervention",
      "efficacy",
      "effectiveness",
    ],
  },
  { name: "diagnosis", triggers: ["diagnos", "test", "biomarker", "imaging"] },
  {
    name: "prognosis",
    triggers: [
      "prognos",
      "survival",
      "mortality",
      "overall survival",
      "progression-free",
    ],
  },
  {
    name: "prevention",
    triggers: ["prevent", "prevention", "vaccin", "prophylaxis", "lifestyle"],
  },
];

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

const CACHE_TTL_MS = 1000 * 60 * 30; // 30 min
const keywordCache = new Map();

function cacheKey(prefix, ...args) {
  return `${prefix}:${args.map((a) => String(a).toLowerCase().trim()).join(":")}`;
}

function getCached(key) {
  const entry = keywordCache.get(key);
  if (!entry || Date.now() > entry.expires) {
    if (entry) keywordCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCache(key, value) {
  keywordCache.set(key, { value, expires: Date.now() + CACHE_TTL_MS });
  if (keywordCache.size > 300) {
    const now = Date.now();
    for (const [k, v] of keywordCache.entries()) {
      if (now > v.expires) keywordCache.delete(k);
    }
  }
}

/** Remove stopwords from a string (lowercased tokens). */
function stripStopwords(text) {
  if (!text || typeof text !== "string") return "";
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .join(" ")
    .trim();
}

/**
 * Detect question type from query using QUESTION_TYPES triggers.
 * @returns {{ name: string, triggers: string[] } | null} Best-matching type or null
 */
export function detectQuestionType(query) {
  if (!query || typeof query !== "string") return null;
  const q = query.toLowerCase().trim();
  let best = null;
  let bestCount = 0;
  for (const qt of QUESTION_TYPES) {
    let count = 0;
    for (const trigger of qt.triggers) {
      if (q.includes(trigger)) count++;
    }
    if (count > bestCount) {
      bestCount = count;
      best = qt;
    }
  }
  return best;
}

/** MeSH / PubMed hints per question type to narrow results. */
const QUESTION_TYPE_MESH = {
  etiology_risk: [
    "epidemiology[mh]",
    "risk factors[mh]",
    "prevalence[mh]",
    "odds ratio[tiab]",
  ],
  screening: [
    "mass screening[mh]",
    "sensitivity and specificity[mh]",
    "early diagnosis[mh]",
  ],
  treatment: [
    "drug therapy[mh]",
    "therapeutics[mh]",
    "treatment outcome[mh]",
    "therapy[sh]",
  ],
  diagnosis: [
    "diagnosis[mh]",
    "diagnostic imaging[mh]",
    "biomarkers[mh]",
    "diagnostic techniques and procedures[mh]",
  ],
  prognosis: [
    "prognosis[mh]",
    "survival rate[mh]",
    "mortality[mh]",
    "disease-free survival[mh]",
  ],
  prevention: [
    "primary prevention[mh]",
    "vaccination[mh]",
    "prophylaxis[mh]",
    "health behavior[mh]",
  ],
};

/**
 * Use Gemini (fast model) to extract publication-search keywords and MeSH-style terms from a user query.
 * Uses question-type detection (etiology, screening, treatment, etc.) to bias toward accurate results.
 *
 * @param {string} userQuery - Raw user search (e.g. "what is the risk of diabetes" or "ADHD treatment")
 * @returns {Promise<{ primaryKeywords: string[], meshTerms: string[], synonyms: string[], relatedConcepts: string[], rawQuery: string, questionType: string | null }>}
 */
export async function generatePublicationKeywords(userQuery) {
  const raw = (userQuery || "").trim();
  if (!raw) {
    return {
      primaryKeywords: [],
      meshTerms: [],
      synonyms: [],
      relatedConcepts: [],
      rawQuery: "",
      questionType: null,
    };
  }

  const questionType = detectQuestionType(raw);
  const key = cacheKey("pub-kw", raw);
  const cached = getCached(key);
  if (cached) {
    return {
      ...cached,
      questionType: cached.questionType ?? questionType?.name ?? null,
    };
  }

  const geminiInstance = getGeminiInstance();
  if (!geminiInstance) {
    return fallbackKeywords(raw);
  }

  const model = geminiInstance.getGenerativeModel({
    model: "gemini-2.5-flash-lite",
  });

  const intentHint = questionType
    ? ` The user's intent appears to be: ${questionType.name.replace(/_/g, " ")}. Emphasize keywords and MeSH terms that retrieve papers about ${questionType.name.replace(/_/g, " ")} (e.g. for treatment: drug therapy, efficacy; for prognosis: survival, mortality; for screening: sensitivity, specificity; for diagnosis: biomarkers, diagnostic accuracy; for prevention: vaccination, prophylaxis; for etiology/risk: risk factors, epidemiology, prevalence).`
    : "";

  const prompt = `You are an academic publication search expert.

Given the user's search query: "${raw}"${intentHint}

Extract terms suitable for searching PubMed, OpenAlex, and similar sources. Output STRICTLY this JSON (no markdown):

{
  "primaryKeywords": ["keyword1", "keyword2"],
  "meshTerms": ["MeSH Term 1", "MeSH Term 2"],
  "synonyms": ["synonym1", "synonym2"],
  "relatedConcepts": ["concept1", "concept2"]
}

Guidelines:
- primaryKeywords: 2–5 core terms that define the topic (disease, intervention, exposure, etc.). Exclude stopwords like "the", "what", "how", "risk" alone unless part of a medical phrase.
- meshTerms: Medical Subject Headings (MeSH) style terms for the condition/topic and intent (e.g. "Drug Therapy", "Prognosis", "Mass Screening").
- synonyms: Alternative names, abbreviations (e.g. "T2DM" for type 2 diabetes).
- relatedConcepts: Broader or closely related concepts that help recall.
Keep each array concise (2–6 items each). Use only the JSON object.`;

  try {
    const result = await rateLimiter.execute(
      async () => {
        return await model.generateContent(prompt, {
          generationConfig: {
            maxOutputTokens: 800,
            temperature: 0.2,
            topP: 0.8,
            topK: 40,
          },
        });
      },
      "gemini-2.5-flash-lite",
      1000,
    );

    let jsonText = result.response.text().trim();
    if (jsonText.startsWith("```")) {
      jsonText = jsonText
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();
    }
    const jsonMatch = jsonText.match(/\{[\s\S]*\}/);
    if (jsonMatch) jsonText = jsonMatch[0];

    const parsed = JSON.parse(jsonText);
    const primaryKeywords = Array.isArray(parsed.primaryKeywords)
      ? parsed.primaryKeywords.filter(Boolean)
      : [];
    const meshTerms = Array.isArray(parsed.meshTerms)
      ? parsed.meshTerms.filter(Boolean)
      : [];
    const synonyms = Array.isArray(parsed.synonyms)
      ? parsed.synonyms.filter(Boolean)
      : [];
    const relatedConcepts = Array.isArray(parsed.relatedConcepts)
      ? parsed.relatedConcepts.filter(Boolean)
      : [];

    const augmented = augmentWithMeSH(raw, {
      primaryKeywords,
      meshTerms,
      synonyms,
      relatedConcepts,
    });

    const out = {
      primaryKeywords: augmented.primaryKeywords,
      meshTerms: augmented.meshTerms,
      synonyms: augmented.synonyms,
      relatedConcepts: augmented.relatedConcepts,
      rawQuery: raw,
      questionType: questionType?.name ?? null,
    };
    setCache(key, out);
    return out;
  } catch (err) {
    console.warn(
      "Publication keyword extraction (Gemini) failed:",
      err?.message,
    );
    return fallbackKeywords(raw);
  }
}

function fallbackKeywords(raw) {
  const tokens = raw
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const primaryKeywords = tokens.length
    ? [tokens.join(" ")]
    : [stripStopwords(raw) || raw];
  const mesh = mapToMeSHTerminology(raw);
  const meshTerms = mesh !== raw ? [mesh] : [];
  const synonyms =
    expandQueryWithSynonyms(raw) !== raw
      ? expandQueryWithSynonyms(raw)
          .split(/\s+OR\s+/)
          .map((s) => s.trim())
      : [];
  const questionType = detectQuestionType(raw);
  return {
    primaryKeywords,
    meshTerms,
    synonyms,
    relatedConcepts: [],
    rawQuery: raw,
    questionType: questionType?.name ?? null,
  };
}

function augmentWithMeSH(raw, extracted) {
  const allTerms = [
    ...extracted.primaryKeywords,
    ...extracted.meshTerms,
    ...extracted.synonyms,
    ...extracted.relatedConcepts,
  ];
  const meshAdded = new Set(extracted.meshTerms);
  const synonymAdded = new Set(extracted.synonyms);

  for (const t of extracted.primaryKeywords) {
    const mesh = mapToMeSHTerminology(t);
    if (mesh && mesh !== t && !meshAdded.has(mesh)) {
      meshAdded.add(mesh);
    }
    const syn = expandQueryWithSynonyms(t);
    if (syn && syn !== t) {
      syn.split(/\s+OR\s+/).forEach((s) => {
        const x = s.trim();
        if (x && !synonymAdded.has(x)) synonymAdded.add(x);
      });
    }
  }

  return {
    primaryKeywords: extracted.primaryKeywords,
    meshTerms: Array.from(meshAdded),
    synonyms: Array.from(synonymAdded),
    relatedConcepts: extracted.relatedConcepts,
  };
}

/**
 * Build PubMed-style query and plain query from extracted keywords.
 * Uses stopword filtering and optional question-type MeSH filters for accurate results.
 *
 * @param {Object} keywords - Result from generatePublicationKeywords
 * @returns {{ pubmedQuery: string, plainQuery: string, queryTerms: string[] }}
 */
export function buildSearchQueryFromKeywords(keywords) {
  if (
    !keywords ||
    (!keywords.primaryKeywords?.length && !keywords.meshTerms?.length)
  ) {
    const raw = (keywords?.rawQuery || "").trim();
    const terms = raw ? stripStopwords(raw).split(/\s+/).filter(Boolean) : [];
    return {
      pubmedQuery: raw,
      plainQuery: raw,
      queryTerms: terms,
    };
  }

  const terms = [
    ...(keywords.primaryKeywords || []),
    ...(keywords.meshTerms || []),
    ...(keywords.synonyms || []).slice(0, 8),
  ].filter(Boolean);
  const unique = [...new Set(terms.map((t) => t.trim()).filter(Boolean))];

  const clauses = unique.slice(0, 12).map((term) => {
    const hasSpace = term.includes(" ");
    const tiab = hasSpace ? `"${term}"[tiab]` : `${term}[tiab]`;
    const mesh = hasSpace ? `"${term}"[mh]` : `${term}[mh]`;
    return `(${tiab} OR ${mesh})`;
  });

  let pubmedQuery = clauses.length
    ? clauses.join(" OR ")
    : keywords.rawQuery || "";

  if (
    keywords.questionType &&
    QUESTION_TYPE_MESH[keywords.questionType]?.length
  ) {
    const intentClauses = QUESTION_TYPE_MESH[keywords.questionType].slice(0, 3);
    pubmedQuery = pubmedQuery
      ? `(${pubmedQuery}) AND (${intentClauses.join(" OR ")})`
      : intentClauses.join(" OR ");
  }

  const plainQuery = unique.join(" ").trim() || keywords.rawQuery || "";
  const queryTerms = unique
    .flatMap((t) =>
      t
        .toLowerCase()
        .replace(/[^\w\s-]/g, " ")
        .split(/\s+/),
    )
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  const queryTermsUnique = [...new Set(queryTerms)];

  return {
    pubmedQuery,
    plainQuery,
    queryTerms: queryTermsUnique,
  };
}
