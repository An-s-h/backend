import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import rateLimiter from "../utils/geminiRateLimiter.js";
import { searchPubMed } from "./pubmed.service.js";
import { searchClinicalTrials } from "./clinicalTrials.service.js";
import { findDeterministicExperts, formatExpertsForResponse } from "./deterministicExperts.service.js";
import { searchGoogleScholarPublications } from "./googleScholar.service.js";
import { fetchTrialById, fetchPublicationById } from "./urlParser.service.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, "..", ".env") });

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2;

if (!apiKey && !apiKey2) {
  console.warn("⚠️  No Google AI API keys found for chatbot (GOOGLE_AI_API_KEY, GOOGLE_AI_API_KEY_2)");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

const CHATBOT_MODELS = ["gemini-2.5-flash", "gemini-1.5-flash", "gemini-2-flash"];

let apiKeyCounter = 0;

function getGeminiInstance(preferAlternate = false) {
  if (!genAI && !genAI2) return null;
  if (!genAI2) return genAI;
  if (!genAI) return genAI2;

  if (preferAlternate) {
    return apiKeyCounter === 0 ? genAI2 : genAI;
  }

  apiKeyCounter = (apiKeyCounter + 1) % 2;
  return apiKeyCounter === 0 ? genAI : genAI2;
}

/**
 * System prompt for the Collabiora health research chatbot
 * @param {boolean} isFirstMessage - Whether this is the first message in the conversation
 */
function getSystemPrompt(isFirstMessage = false) {
  const introductionNote = isFirstMessage 
    ? `**IMPORTANT**: This is the first message in the conversation. You may introduce yourself briefly as Yori if the user greets you (e.g., "hi", "hey", "hello").`
    : `**CRITICAL**: This is NOT the first message. The user already knows who you are. DO NOT introduce yourself again. DO NOT say "Hello! I'm Yori" or any variation of introducing yourself. Jump straight to answering their question or providing the information they need.`;

  return `You are Yori, the user's personal AI assistant on Collabiora - a comprehensive health research platform. Your role is to help users discover and understand health research information. Refer to the platform as Collabiora.

${introductionNote}

## Your Capabilities:

1. **Publications Search**: Help users find relevant medical research papers, scientific publications, and clinical studies
2. **Clinical Trials**: Assist in discovering ongoing clinical trials, explaining trial details, eligibility criteria, and locations
3. **Expert Discovery**: Help find researchers, doctors, and medical experts in specific fields or conditions
4. **Medical Information**: Explain medical concepts, conditions, treatments, and research findings in accessible language
5. **Research Guidance**: Provide guidance on understanding research papers, trial protocols, and medical terminology

## Important Guidelines:

- Always prioritize accuracy and cite that information should be verified with healthcare professionals
- Use clear, accessible language while maintaining medical accuracy
- When discussing medical conditions or treatments, remind users to consult healthcare providers
- For clinical trials, emphasize the importance of discussing participation with their doctor
- Be empathetic and supportive, especially when discussing serious health conditions
- If you don't know something, admit it rather than speculating
- When you receive formatted search results (publications, trials, or experts), present them clearly and concisely
- For search results, provide a brief introduction, then list each result with key details
- Keep search result presentations concise (3-4 items max) but informative
- **When answering questions about specific items (trials, publications, experts) WITHOUT context provided, you may include source links for verification**
- **When context is explicitly provided (user is viewing a specific trial/publication page), do NOT include external links - the user already has access to the item**
- **For trial questions, provide specific eligibility criteria when asked about inclusion criteria**
- **For publication questions, cite the PMID when relevant, but do NOT include PubMed links when context is provided**
- **Always base your answers on the provided item details - do not make up information**

## Response Style:

- Be concise but thorough
- Use bullet points for clarity when listing information
- Break down complex medical terms
- Provide context for research findings (e.g., study size, limitations)
- When presenting search results, format them nicely with clear headings and key information
- Use markdown formatting for better readability (bold titles, bullet points, links)
- Encourage users to explore Collabiora's search features for deeper research
- **CRITICAL**: Never use "CuraBot" or "CuraLink" - always use "Yori" and "Collabiora"

**Conversation consistency**: Stay consistent throughout the entire conversation. Do not contradict your prior answers. If the user follows up on a topic you already discussed, build on that context rather than restarting. Maintain the same tone, depth, and approach across turns.

**Citations and publications**: When making medical or research claims (treatments, conditions, study findings, trends), include supporting publications when possible. Cite PMIDs, journal names, or provide links so users can verify and explore further. When sources are provided with your response (e.g., "Sources" section), reference them inline (e.g., "According to recent research [1]..."). If you cannot cite a specific source, recommend that users search PubMed or consult their healthcare provider for verification.

Remember: You're a research assistant, not a replacement for medical advice. Always emphasize the importance of consulting healthcare professionals for personal medical decisions.

**When the user asks about a specific trial**: A formatted card will show the requested information. Keep your text response very brief (1-3 sentences) - do NOT repeat the details that appear in the card. Just add a short contextual note or suggest next steps.`;
}

/**
 * Detect which trial section(s) the user is asking for - show only that section in the card
 */
function detectTrialSectionFocus(query) {
  const q = query.toLowerCase().trim();
  if (/\b(contact|phone|email|reach|get in touch|who do i contact|contact details)\b/.test(q)) return ["contacts"];
  if (/\b(inclusion|exclusion|eligibility|criteria|qualify|participate|who can)\b/.test(q)) return ["eligibility"];
  if (/\b(location|where|site|place|conducted|enrolling)\b/.test(q)) return ["locations"];
  return ["overview"];
}

/**
 * Detect "general knowledge" / "web overview" questions - e.g. trends, research patterns, medical info.
 * Uses Google Search grounding to provide citations. EXCLUDES "recent publications" and "recent trials"
 * - those fetch from our APIs instead.
 */
function detectGeneralKnowledgeIntent(query) {
  const q = query.toLowerCase().trim();
  if (q.length < 10) return false;
  // Exclude explicit publications/trials searches - those use our API
  if (/\b(recent|latest)\s+(publications?|trials?)\s+(on|for|about)\b/.test(q)) return false;
  if (/\bshow\s+me\s+(recent|latest)\s+(publications?|trials?)\b/.test(q)) return false;
  const patterns = [
    // Trends and research overviews
    /\b(recent|latest|newest|current)\s+(research|studies?|findings?|developments?)\b/,
    /\b(recent|latest|trends?)\s+(in|on)\s+(?!publications?|trials?)/,
    /\b(overview|summary)\s+of\s+.+\s+research\b/,
    /\b(what('s| is)\s+new|what('s| are)\s+the\s+trends)\s+(in|on)\b/,
    /\b(trends?|developments?)\s+(in|in the)\s+(latest|current)\b/,
    /\bresearch\s+patterns?\b/,
    /\b(trends?|latest)\s+in\s+(parkinson|diabetes|alzheimer|cancer|heart)\b/i,
    // Medical/health info that benefits from grounded citations
    /\bwhat\s+(are|is)\s+(the\s+)?(symptoms?|treatments?|causes?|risk\s+factors?)\s+(of|for)\b/,
    /\b(how\s+is|how\s+do\s+you\s+treat|what\s+treatments?)\s+(exist\s+for)?\b/,
    /\blatest\s+(research|evidence|studies?)\s+(on|about|for)\b/,
    /\bcurrent\s+(understanding|evidence|research)\s+(on|about)\b/,
  ];
  return patterns.some((p) => p.test(q));
}

/** Detect if query asks for "recent" or "latest" - use date sort when fetching from APIs */
function wantsRecentSort(query) {
  const q = query.toLowerCase().trim();
  return /\b(recent|latest|newest|current)\b/.test(q);
}

/** Show full publication card only for "display/show" requests. Summarize, findings, conclusions, methods, takeaways get AI analysis. */
function detectPublicationSummaryFocus(query) {
  const q = query.toLowerCase().trim();
  // Full card only when user wants to see the raw publication/abstract (no analysis)
  if (/\b(show (me )?this (paper|publication|article)|display (the )?(abstract|publication)|view (the )?abstract)\b/.test(q)) return true;
  return false;
}

/**
 * Detect if user is asking to "pull up" or "get" the link to a specific publication by name/title
 */
function detectPublicationLinkIntent(query) {
  const q = query.toLowerCase().trim();
  const patterns = [
    /\b(pull up|get|give me|show me|find me|fetch)\s+(the\s+)?(link|url)\s+to\b/,
    /\b(link|url)\s+to\s+(the\s+)?(publication|paper|article|study)\b/,
    /\bcan\s+(you|u)\s+(pull up|get|find|show)\s+(the\s+)?(link\s+to)?\b/,
    /\b(pull up|get)\s+link\s+to\b/,
  ];
  return patterns.some((p) => p.test(q));
}

/**
 * Extract publication title from "pull up link to X" / "link to X" style queries
 */
function extractPublicationTitleFromLinkRequest(query) {
  const q = query.trim();
  const patterns = [
    /\b(?:pull up|get|give me|show me|find me|fetch)\s+(?:the\s+)?(?:link\s+to|link)\s+(?:the\s+)?(?:publication\s+)?["']?(.+?)["']?\s*[.?!]?$/i,
    /\b(?:can\s+(?:you|u)\s+)(?:pull up|get|find|show)\s+(?:the\s+)?(?:link\s+to\s+)?["']?(.+?)["']?\s*[.?!]?$/i,
    /\b(?:link|url)\s+to\s+(?:the\s+)?(?:publication\s+)?["']?(.+?)["']?\s*[.?!]?$/i,
    /\b(?:pull up|get)\s+link\s+to\s+["']?(.+?)["']?\s*[.?!]?$/i,
  ];
  for (const pattern of patterns) {
    const match = q.match(pattern);
    if (match && match[1]) {
      let title = match[1].trim();
      title = title.replace(/\s*[.;:!?]+$/, "").trim();
      if (title.length >= 5) return title;
    }
  }
  // Fallback: strip common prefixes and use the rest as title
  const stripped = q
    .replace(/^(?:can you|can u|could you)\s+(?:please\s+)?(?:pull up|get|find|show)\s+(?:the\s+)?link\s+to\s+/i, "")
    .replace(/^(?:pull up|get|give me|show me)\s+(?:the\s+)?link\s+to\s+/i, "")
    .replace(/\s*[.;:!?]+$/, "")
    .trim();
  return stripped.length >= 5 ? stripped : null;
}

/**
 * Detect if query is asking for publications, trials, experts, or researcher-specific publications
 */
function detectSearchIntent(query) {
  const lowerQuery = query.toLowerCase();
  
  // Check for researcher-specific publications FIRST (e.g., "publications by Dr. Smith", "papers by John Doe")
  const researcherPubPatterns = [
    /(?:publications?|papers?|articles?|works?|research)\s+(?:by|from|of|authored by)\s+/i,
    /(?:by|from|of|authored by)\s+(?:dr\.?|prof\.?|professor)\s+/i,
    /(?:find|show|get|list)\s+(?:publications?|papers?|articles?|works?)\s+(?:by|from|of)\s+/i,
    /(?:what has|what did)\s+.+\s+(?:published|written|authored)/i,
    /(?:published|written|authored)\s+by\s+/i,
  ];
  
  const hasResearcherPubIntent = researcherPubPatterns.some(pattern => 
    pattern.test(lowerQuery)
  );
  
  if (hasResearcherPubIntent) return "researcher_publications";
  
  const publicationKeywords = [
    "publication", "publications", "paper", "papers", "article", "articles",
    "research paper", "research papers", "study", "studies", "journal",
    "find publications", "show publications", "get publications",
    "publications on", "publications about", "papers on", "papers about"
  ];
  
  const trialKeywords = [
    "trial", "trials", "clinical trial", "clinical trials",
    "find trials", "show trials", "get trials", "trials for",
    "trials on", "trials about", "ongoing trials", "clinical study",
    "clinical studies", "find clinical trials", "show clinical trials",
    "get clinical trials", "clinical trial for", "clinical trial on"
  ];
  
  const expertKeywords = [
    "expert", "experts", "researcher", "researchers", "doctor", "doctors",
    "specialist", "specialists", "scientist", "scientists", "professor", "professors",
    "find experts", "show experts", "get experts",
    "experts in", "experts on", "experts about", "researchers in",
    "find researcher", "find researchers", "find doctor", "find specialist",
    "who works on", "who researches", "who studies",
    "top researchers", "top experts", "leading experts", "leading researchers"
  ];
  
  const hasPublicationIntent = publicationKeywords.some(keyword => 
    lowerQuery.includes(keyword)
  );
  
  const hasTrialIntent = trialKeywords.some(keyword => 
    lowerQuery.includes(keyword)
  );
  
  const hasExpertIntent = expertKeywords.some(keyword => 
    lowerQuery.includes(keyword)
  );
  
  if (hasPublicationIntent) return "publications";
  if (hasTrialIntent) return "trials";
  if (hasExpertIntent) return "experts";
  
  return null;
}

/**
 * Extract search query from user message
 */
function extractSearchQuery(query, intent) {
  // For researcher_publications, extract the researcher name
  if (intent === "researcher_publications") {
    return extractResearcherName(query);
  }
  
  // Try to extract the main topic after common patterns
  const patterns = [
    /(?:find|show|get|bring|give|list)\s+(?:publications?|papers?|articles?|trials?|clinical\s+trials?|experts?|researchers?)\s+(?:on|about|for|in|related\s+to|regarding)\s+(.+)/i,
    /(?:publications?|papers?|articles?|trials?|clinical\s+trials?|experts?|researchers?)\s+(?:on|about|for|in|related\s+to|regarding)\s+(.+)/i,
    /(?:on|about|for|in|related\s+to|regarding)\s+(.+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      let extracted = match[1].trim();
      // Remove trailing punctuation and common words
      extracted = extracted.replace(/[.,;:!?]+$/, "").trim();
      if (extracted.length >= 3) {
        return extracted;
      }
    }
  }
  
  // Fallback: remove intent keywords and common phrases
  let cleaned = query.toLowerCase();
  
  const removePhrases = [
    "find", "show", "get", "bring", "me", "give", "list",
    "publications", "publication", "papers", "paper", "articles", "article",
    "trials", "trial", "clinical trials", "clinical trial", "clinical studies", "clinical study",
    "experts", "expert", "researchers", "researcher", "specialists", "specialist",
    "scientists", "scientist", "professors", "professor", "doctors", "doctor",
  ];
  
  // Remove common phrases
  for (const phrase of removePhrases) {
    cleaned = cleaned.replace(new RegExp(`\\b${phrase}\\b`, "gi"), "");
  }
  
  // Remove common prepositions but keep the content after them
  cleaned = cleaned.replace(/\b(on|about|for|in|related to|regarding)\s+/gi, "");
  
  // Clean up extra spaces
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  
  return cleaned || query.trim();
}

/**
 * Extract researcher name from a query like "publications by Dr. John Smith"
 */
function extractResearcherName(query) {
  const patterns = [
    /(?:publications?|papers?|articles?|works?|research)\s+(?:by|from|of|authored by)\s+(.+)/i,
    /(?:find|show|get|list)\s+(?:publications?|papers?|articles?|works?)\s+(?:by|from|of)\s+(.+)/i,
    /(?:by|from|of|authored by)\s+((?:dr\.?|prof\.?|professor)\s+.+)/i,
    /(?:what has|what did)\s+(.+?)\s+(?:published|written|authored)/i,
    /(?:published|written|authored)\s+by\s+(.+)/i,
  ];
  
  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      let name = match[1].trim();
      // Remove trailing punctuation
      name = name.replace(/[.,;:!?]+$/, "").trim();
      // Remove trailing common words
      name = name.replace(/\s+(please|thanks|thank you|recently|lately)$/i, "").trim();
      if (name.length >= 2) {
        return name;
      }
    }
  }
  
  // Fallback: remove publication-related words and return the rest
  let cleaned = query
    .replace(/(?:find|show|get|list|give me)\s+/gi, "")
    .replace(/(?:publications?|papers?|articles?|works?|research)\s+/gi, "")
    .replace(/\b(by|from|of|authored by)\s+/gi, "")
    .replace(/[.,;:!?]+$/, "")
    .trim();
  
  return cleaned || query.trim();
}

/**
 * Fetch publications from backend
 * @param {string} query - Search query
 * @param {number} limit - Max items to return
 * @param {boolean} sortByDate - When true, sort by date (newest first)
 */
async function fetchPublications(query, limit = 4, sortByDate = false) {
  try {
    const result = await searchPubMed({
      q: query,
      page: 1,
      pageSize: limit,
      sort: sortByDate ? "date" : "relevance",
    });
    
    const publications = (result.items || []).slice(0, limit);
    
    return publications.map(pub => ({
      title: pub.title || "Untitled",
      authors: pub.authors?.slice(0, 3).join(", ") || "Unknown authors",
      journal: pub.journal || "Unknown journal",
      year: pub.year || "Unknown year",
      pmid: pub.pmid,
      abstract: pub.abstract ? pub.abstract.substring(0, 200) + "..." : "No abstract available",
      url: `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}`,
    }));
  } catch (error) {
    console.error("Error fetching publications:", error);
    return [];
  }
}

/**
 * Fetch clinical trials from backend
 * @param {string} query - Search query
 * @param {number} limit - Max items to return
 * @param {boolean} sortByDate - When true, sort by lastUpdatePostDate (newest first)
 */
async function fetchTrials(query, limit = 4, sortByDate = false) {
  try {
    const result = await searchClinicalTrials({
      q: query,
      page: 1,
      pageSize: limit,
      sortByDate,
    });
    
    const trials = (result.items || []).slice(0, limit);
    
    return trials.map(trial => {
      // Handle locations - can be array of objects or strings
      let locationsStr = "Multiple locations";
      if (trial.locations && Array.isArray(trial.locations)) {
        const locationNames = trial.locations
          .slice(0, 3)
          .map(loc => {
            if (typeof loc === 'string') return loc;
            return loc.city || loc.name || loc.location || null;
          })
          .filter(Boolean);
        if (locationNames.length > 0) {
          locationsStr = locationNames.join(", ");
        }
      }
      
      // Handle conditions - can be array or string
      let conditionsStr = "Not specified";
      if (trial.conditions) {
        if (Array.isArray(trial.conditions)) {
          conditionsStr = trial.conditions.slice(0, 3).join(", ");
        } else {
          conditionsStr = trial.conditions;
        }
      }
      
      // Get summary/description
      const summary = trial.summary || trial.briefSummary || trial.description || "No summary available";
      const summaryText = summary.length > 200 ? summary.substring(0, 200) + "..." : summary;
      
      // Get NCT ID
      const nctId = trial.id || trial.nctId || trial.nct_id;
      
      return {
        title: trial.title || trial.briefTitle || trial.officialTitle || "Untitled Trial",
        nctId: nctId,
        status: trial.status || trial.overallStatus || "Unknown",
        phase: trial.phase || trial.phases?.join(", ") || "Not specified",
        conditions: conditionsStr,
        locations: locationsStr,
        summary: summaryText,
        url: nctId ? `https://clinicaltrials.gov/study/${nctId}` : "#",
      };
    });
  } catch (error) {
    console.error("Error fetching trials:", error);
    return [];
  }
}

/**
 * Fetch experts using OpenAlex deterministic discovery (same as Experts page)
 */
async function fetchExperts(query, limit = 4) {
  try {
    console.log(`[Chatbot] Fetching experts via OpenAlex for: "${query}"`);
    const result = await findDeterministicExperts(query, null, 1, limit, {
      limitOpenAlexProfiles: true,
      skipAISummaries: false,
    });
    
    if (!result || !result.experts || result.experts.length === 0) {
      console.log("[Chatbot] No experts found via OpenAlex");
      return [];
    }
    
    // Format using the same formatter as the Experts page, then map to chatbot card fields
    const formatted = formatExpertsForResponse(result.experts);
    
    return formatted.slice(0, limit).map(expert => ({
      name: expert.name || "Unknown Researcher",
      affiliation: expert.affiliation || "Unknown institution",
      location: expert.location || "Unknown location",
      bio: expert.biography || "No biography available",
      researchInterests: expert.recentWorks?.map(w => w.title).slice(0, 2).join("; ") || "Not specified",
      // Extra fields for richer cards
      orcid: expert.orcid || null,
      orcidUrl: expert.orcidUrl || null,
      metrics: expert.metrics || null,
      confidence: expert.confidence || null,
      recentWorks: expert.recentWorks || [],
    }));
  } catch (error) {
    console.error("Error fetching experts via OpenAlex:", error);
    return [];
  }
}

/**
 * Fetch publications by a specific researcher using OpenAlex
 */
async function fetchResearcherPublications(researcherName, limit = 4) {
  try {
    console.log(`[Chatbot] Fetching publications by researcher: "${researcherName}"`);
    const publications = await searchGoogleScholarPublications({
      author: researcherName,
      num: limit,
    });
    
    if (!publications || publications.length === 0) {
      console.log(`[Chatbot] No publications found for researcher: "${researcherName}"`);
      return [];
    }
    
    return publications.slice(0, limit).map(pub => ({
      title: pub.title || "Untitled",
      authors: Array.isArray(pub.authors) ? pub.authors.slice(0, 3).join(", ") : (pub.authors || researcherName),
      journal: pub.journal || pub.venue || "Unknown journal",
      year: pub.year || pub.publicationDate?.substring(0, 4) || "Unknown year",
      pmid: pub.pmid || pub.doi || null,
      abstract: pub.abstract ? (pub.abstract.length > 200 ? pub.abstract.substring(0, 200) + "..." : pub.abstract) : "No abstract available",
      url: pub.url || pub.doi ? `https://doi.org/${pub.doi}` : (pub.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}` : "#"),
      citations: pub.citationCount || pub.citations || 0,
    }));
  } catch (error) {
    console.error("Error fetching researcher publications:", error);
    return [];
  }
}

/**
 * Build context information for item-specific questions
 */
function buildItemContext(itemContext) {
  if (!itemContext || !itemContext.item) {
    return "";
  }
  
  const item = itemContext.item;
  let contextInfo = "";
  
  if (itemContext.type === "trial") {
    const trialUrl = item.url || item.clinicalTrialsGovUrl || `https://clinicaltrials.gov/study/${item.nctId || item.id}`;
    const conditionsStr = Array.isArray(item.conditions) ? item.conditions.join(", ") : (item.conditions || "Not specified");
    contextInfo = `\n\n[User is asking about this specific clinical trial. Use ONLY the following information from the official trial record. Always cite the trial link for verification:]\n\n`;
    contextInfo += `Trial Title: ${item.title || item.briefTitle || "Unknown"}\n`;
    contextInfo += `NCT ID: ${item.nctId || item.id || "Unknown"}\n`;
    contextInfo += `Trial Link: ${trialUrl}\n`;
    contextInfo += `Status: ${item.status || "Unknown"}\n`;
    contextInfo += `Phase: ${item.phase || "Not specified"}\n`;
    contextInfo += `Conditions: ${conditionsStr}\n`;
    if (item.eligibilityCriteria) {
      contextInfo += `\nEligibility / Inclusion-Exclusion Criteria:\n${item.eligibilityCriteria}\n`;
    }
    if (item.eligibility && typeof item.eligibility === "object") {
      const e = item.eligibility;
      if (e.minimumAge || e.maximumAge) contextInfo += `Age: ${e.minimumAge || "?"} - ${e.maximumAge || "?"}\n`;
      if (e.gender) contextInfo += `Gender: ${e.gender}\n`;
      if (e.healthyVolunteers) contextInfo += `Healthy Volunteers: ${e.healthyVolunteers}\n`;
      if (e.population) contextInfo += `Study Population: ${e.population}\n`;
    }
    if (item.detailedDescription || item.description) {
      contextInfo += `\nDetailed Description:\n${item.detailedDescription || item.description}\n`;
    }
    if (item.summary && item.summary !== (item.detailedDescription || item.description)) {
      contextInfo += `\nSummary:\n${item.summary}\n`;
    }
    if (item.contacts && item.contacts.length > 0) {
      contextInfo += `\nContact Details:\n`;
      item.contacts.forEach((c, i) => {
        contextInfo += `  ${i + 1}. ${c.name || "Contact"}${c.role ? ` (${c.role})` : ""}`;
        if (c.phone) contextInfo += ` - Phone: ${c.phone}`;
        if (c.email) contextInfo += ` - Email: ${c.email}`;
        contextInfo += "\n";
      });
    }
    if (item.locations && item.locations.length > 0) {
      contextInfo += `\nTrial Locations:\n`;
      item.locations.forEach((loc, i) => {
        const addr = loc.fullAddress || loc.address || [loc.facility, loc.city, loc.state, loc.country].filter(Boolean).join(", ");
        contextInfo += `  ${i + 1}. ${addr}`;
        if (loc.contactName || loc.contactPhone || loc.contactEmail) {
          contextInfo += ` - Contact: ${loc.contactName || ""} ${loc.contactPhone || ""} ${loc.contactEmail || ""}`.trim();
        }
        contextInfo += "\n";
      });
    }
    contextInfo += `\n\n[Important: Answer only from the trial details above. Use SIMPLIFIED, PLAIN LANGUAGE. Format your response with clear markdown: use ## for main section headers, **bold** for labels, - for bullet points. Do NOT include links to ClinicalTrials.gov or any external sites. Do not dump raw data - synthesize and explain in a helpful way based on the user's question.]`;
  } else if (itemContext.type === "publication") {
    contextInfo = `\n\n[User is asking about this specific publication. Use the following information to answer their question accurately. Always cite the PubMed link for verification:]\n\n`;
    contextInfo += `Title: ${item.title || "Unknown"}\n`;
    contextInfo += `Authors: ${item.authors || "Unknown"}\n`;
    contextInfo += `Journal: ${item.journal || "Unknown"} (${item.year || "Unknown"})\n`;
    contextInfo += `PMID: ${item.pmid || "Unknown"}\n`;
    contextInfo += `Publication Link: ${item.url || `https://pubmed.ncbi.nlm.nih.gov/${item.pmid}`}\n`;
    if (item.fullAbstract || item.abstract) {
      contextInfo += `\nAbstract:\n${item.fullAbstract || item.abstract}\n`;
    }
    if (item.keywords && item.keywords.length > 0) {
      contextInfo += `\nKeywords: ${Array.isArray(item.keywords) ? item.keywords.join(", ") : item.keywords}\n`;
    }
    contextInfo += `\n\n[Important: Always provide accurate information based on the publication details above. Use SIMPLIFIED, PLAIN LANGUAGE that a general audience can understand - avoid jargon, explain medical/scientific terms when needed, and keep sentences clear and concise. Format your response with clear markdown structure: use ## for main section headers (e.g. ## Key Takeaways), **bold** for subsection labels (e.g. **Nature and Prevalence:**), and - for bullet points. Do NOT include links to PubMed or any external sites. Do not include raw URLs as plain text.]`;
  } else if (itemContext.type === "expert") {
    const expertName = item.name || "Unknown";
    const profilePath = item.userId || item.id || item._id
      ? `/collabiora-expert/profile/${item.userId || item.id || item._id}`
      : `/expert/profile?name=${encodeURIComponent(expertName)}`;
    contextInfo = `\n\n[User is asking about this specific expert/researcher. Use the following information to answer their question accurately:]\n\n`;
    contextInfo += `Name: ${expertName}\n`;
    contextInfo += `Affiliation: ${item.affiliation || "Unknown"}\n`;
    contextInfo += `Location: ${item.location || "Unknown"}\n`;
    if (item.bio || item.biography) {
      contextInfo += `\nBiography:\n${item.bio || item.biography}\n`;
    }
    if (item.researchInterests) {
      contextInfo += `\nResearch Interests: ${item.researchInterests}\n`;
    }
    contextInfo += `\nProfile URL (include this link at the end of your response): ${profilePath}\n`;
    contextInfo += `\n\n[Important: Provide information about this researcher's background, expertise, and contributions based on the details above. End your response with a markdown link so the user can view the full profile: [View profile](${profilePath})]`;
  }
  
  return contextInfo;
}

/**
 * Format search results for AI response
 */
function formatSearchResults(intent, results) {
  if (!results || results.length === 0) {
    return "I couldn't find any results for your search. Please try rephrasing your query.";
  }
  
  let formatted = `\n\n**Found ${results.length} ${intent}:**\n\n`;
  
  results.forEach((item, index) => {
    formatted += `**${index + 1}. ${item.title || item.name}**\n`;
    
    if (intent === "publications") {
      formatted += `   - Authors: ${item.authors}\n`;
      formatted += `   - Journal: ${item.journal} (${item.year})\n`;
      formatted += `   - Abstract: ${item.abstract}\n`;
      formatted += `   - [View Publication](https://pubmed.ncbi.nlm.nih.gov/${item.pmid})\n`;
    } else if (intent === "trials") {
      formatted += `   - Status: ${item.status} | Phase: ${item.phase}\n`;
      formatted += `   - Conditions: ${item.conditions}\n`;
      formatted += `   - Locations: ${item.locations}\n`;
      formatted += `   - Summary: ${item.summary}\n`;
      formatted += `   - [View Trial](https://clinicaltrials.gov/study/${item.nctId})\n`;
    } else if (intent === "experts") {
      formatted += `   - Affiliation: ${item.affiliation}\n`;
      formatted += `   - Location: ${item.location}\n`;
      formatted += `   - Research Interests: ${item.researchInterests}\n`;
      formatted += `   - Bio: ${item.bio.substring(0, 150)}...\n`;
    }
    
    formatted += "\n";
  });
  
  formatted += `\n*Showing top ${results.length} results. Use Collabiora's search pages for more comprehensive results.*\n`;
  
  return formatted;
}

/**
 * Generate a streaming chat response using Gemini
 * @param {Array} messages - Array of message objects with role and content
 * @param {Object} res - Express response object for streaming
 * @param {Object} req - Express request object (for user context)
 */
export async function generateChatResponse(messages, res, req = null) {
  const geminiInstance = getGeminiInstance();
  
  if (!geminiInstance) {
    throw new Error("Gemini API not configured");
  }

  const lastMessage = messages[messages.length - 1];
  const userQuery = lastMessage.content;
  
  // Check if message has context (user asking about a specific item)
  // Also check request body for context (from detail pages)
  let itemContext = null;
  if (lastMessage.context && lastMessage.context.item) {
    itemContext = lastMessage.context;
    console.log(`[Chatbot] User asking about specific ${itemContext.type}:`, itemContext.item.title || itemContext.item.name);
  } else if (req && req.body && req.body.context) {
    // Context passed from request body (detail pages)
    itemContext = req.body.context;
    console.log(`[Chatbot] Context from request body: ${itemContext.type}`);
    
    // Fetch detailed information for the item (single-trial detail API for trials)
    try {
      if (itemContext.type === "trial" && (itemContext.item.nctId || itemContext.item.id)) {
        const nctId = itemContext.item.nctId || itemContext.item.id;
        const detailedTrial = await fetchTrialById(nctId);
        if (detailedTrial) {
          const eligibilityCriteria = detailedTrial.eligibility?.criteria ?? detailedTrial.eligibilityCriteria ?? "";
          const description = detailedTrial.description ?? detailedTrial.detailedDescription ?? itemContext.item.summary ?? "";
          itemContext.item = {
            ...itemContext.item,
            ...detailedTrial,
            nctId: detailedTrial.id || nctId,
            url: detailedTrial.clinicalTrialsGovUrl || itemContext.item.url,
            eligibilityCriteria,
            detailedDescription: description,
            summary: description || itemContext.item.summary,
            contacts: detailedTrial.contacts || [],
            locations: detailedTrial.locations || [],
            eligibility: detailedTrial.eligibility || {},
          };
          console.log(`[Chatbot] Loaded full trial details for ${nctId} (eligibility, contacts, locations)`);
        }
      } else if (itemContext.type === "publication" && itemContext.item.pmid) {
        const detailedPub = await fetchPublicationById(itemContext.item.pmid);
        if (detailedPub) {
          itemContext.item = {
            ...itemContext.item,
            ...detailedPub,
            // Include full details
            fullAbstract: detailedPub.abstract || itemContext.item.abstract || "",
            fullText: detailedPub.fullText || "",
            meshTerms: detailedPub.meshTerms || [],
            keywords: detailedPub.keywords || [],
          };
        }
      }
    } catch (error) {
      console.error(`[Chatbot] Error fetching detailed ${itemContext.type} info:`, error);
      // Continue with available data
    }
  }
  
  // Check for "general knowledge" / "web overview" questions - use Gemini with Google Search grounding
  const useGroundedOverview = detectGeneralKnowledgeIntent(userQuery) && !itemContext && (apiKey || apiKey2);

  // Check if user is asking to "pull up link" to a specific publication by title (trial for this feature)
  if (!itemContext && detectPublicationLinkIntent(userQuery)) {
    const pubTitle = extractPublicationTitleFromLinkRequest(userQuery);
    if (pubTitle) {
      try {
        const linkResults = await fetchPublications(pubTitle, 3, false);
        if (linkResults && linkResults.length > 0) {
          const pub = linkResults[0];
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.write(`data: ${JSON.stringify({ text: "Here's the publication you asked for:" })}\n\n`);
          const publicationDetails = {
            showFullCard: true,
            title: pub.title || "Unknown",
            pmid: pub.pmid,
            url: pub.url || `https://pubmed.ncbi.nlm.nih.gov/${pub.pmid}`,
            authors: pub.authors || "Unknown",
            journal: pub.journal || "Unknown",
            year: pub.year || "Unknown",
            abstract: pub.abstract || null,
            keywords: null,
            publicationTypes: null,
          };
          res.write(`data: ${JSON.stringify({ publicationDetails })}\n\n`);
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
          return;
        }
      } catch (linkErr) {
        console.warn("[Chatbot] Pull-up-link search failed:", linkErr.message);
      }
    }
  }

  // Check if user is asking for publications, trials, or experts
  const searchIntent = detectSearchIntent(userQuery);
  
  let searchResults = null;
  let searchQuery = null;
  
  // If general knowledge intent: use Gemini with Google Search grounding (paragraph + sources)
  if (useGroundedOverview) {
    try {
      const { GoogleGenAI } = await import("@google/genai");
      const key = apiKey || apiKey2;
      const ai = new GoogleGenAI({ apiKey: key });
      const groundingTool = { googleSearch: {} };
      const config = { tools: [groundingTool] };

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");

      const prompt = `${userQuery}\n\nYou are Yori, a health research assistant on Collabiora. Provide a clear, accurate overview using recent web sources. Focus on summarizing key information (research, treatments, trends, or medical concepts). Use accessible language. When making claims, reference sources inline where possible (e.g., "According to [1]..."). End with a brief note that sources are listed below for further reading.`;
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
        config,
      });

      const text = response?.text || "";
      const groundingMetadata = response?.candidates?.[0]?.groundingMetadata;
      const chunks = groundingMetadata?.groundingChunks || [];
      const sources = chunks
        .filter((c) => c?.web?.uri)
        .map((c, i) => ({ index: i + 1, url: c.web.uri, title: c.web.title || `Source ${i + 1}` }));

      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
      if (sources.length > 0) {
        res.write(`data: ${JSON.stringify({ groundingSources: sources })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    } catch (groundErr) {
      console.warn("[Chatbot] Grounded overview failed, falling back to standard flow:", groundErr.message);
      // Fall through to standard flow
    }
  }

  // If search intent detected and no item context, fetch real data
  if (searchIntent && !itemContext) {
    searchQuery = extractSearchQuery(userQuery, searchIntent);
    const sortByDate = wantsRecentSort(userQuery);
    console.log(`[Chatbot] Detected ${searchIntent} intent for query: "${searchQuery}"${sortByDate ? " (recent/latest sort)" : ""}`);
    
    try {
      if (searchIntent === "publications") {
        searchResults = await fetchPublications(searchQuery, 4, sortByDate);
      } else if (searchIntent === "trials") {
        searchResults = await fetchTrials(searchQuery, 4, sortByDate);
      } else if (searchIntent === "experts") {
        searchResults = await fetchExperts(searchQuery, 4);
      } else if (searchIntent === "researcher_publications") {
        searchResults = await fetchResearcherPublications(searchQuery, 4);
      }
      
      console.log(`[Chatbot] Fetched ${searchResults?.length || 0} ${searchIntent} results`);
    } catch (error) {
      console.error(`[Chatbot] Error fetching ${searchIntent}:`, error);
      // Continue with AI response even if search fails
      searchResults = null;
    }
  }

  try {
    // Convert messages to Gemini format
    // Filter out the initial assistant greeting and only keep actual conversation
    // When context is provided (detail pages), limit history to only messages with matching context
    let filteredMessages = messages.slice(0, -1);
    
    if (itemContext && itemContext.item) {
      // Limit conversation history to only messages related to the current item
      const currentItemId = itemContext.item.nctId || itemContext.item.id || itemContext.item.pmid;
      filteredMessages = filteredMessages.filter((msg, index) => {
        // Skip the first message if it's from assistant (initial greeting)
        if (index === 0 && msg.role === "assistant") {
          return false;
        }
        // For user messages with context, only keep if they match the current item
        if (msg.role === "user" && msg.context && msg.context.item) {
          const msgItemId = msg.context.item.nctId || msg.context.item.id || msg.context.item.pmid;
          return msgItemId === currentItemId;
        }
        // Keep assistant messages (they're responses to context questions)
        // Keep user messages without context (they'll get context added)
        return true;
      });
    } else {
      // No context - filter normally (just skip initial greeting)
      filteredMessages = filteredMessages.filter((msg, index) => {
        if (index === 0 && msg.role === "assistant") {
          return false;
        }
        return true;
      });
    }
    
    const chatHistory = filteredMessages.map(msg => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

    // Check if this is the first user message (no previous user messages in history)
    const hasPreviousUserMessages = filteredMessages.some(msg => msg.role === "user");
    const isFirstMessage = !hasPreviousUserMessages;

    // Set headers for SSE (Server-Sent Events)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Determine the display type for cards (researcher_publications should render as publication cards)
    const cardType = searchIntent === "researcher_publications" ? "publications" : searchIntent;
    
    // If we have search results, generate AI paragraph summary first, then send cards
    if (searchResults && Array.isArray(searchResults) && searchResults.length > 0 && !itemContext) {
      console.log(`[Chatbot] Generating AI summary for ${searchResults.length} ${searchIntent} results, then sending cards`);
      
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      
      // Build context for AI to summarize the fetched results
      const resultsContext = searchResults.map((item, i) => {
        if (searchIntent === "publications" || searchIntent === "researcher_publications") {
          return `[${i + 1}] "${item.title}" - ${item.authors} (${item.journal}, ${item.year}). ${item.abstract || ""}`;
        } else if (searchIntent === "trials") {
          return `[${i + 1}] "${item.title}" - ${item.status}, ${item.phase}. Conditions: ${item.conditions}. ${item.summary || ""}`;
        } else if (searchIntent === "experts") {
          const metrics = item.metrics ? ` (${item.metrics.totalPublications || 0} publications, ${item.metrics.totalCitations || 0} citations)` : "";
          return `[${i + 1}] ${item.name} - ${item.affiliation || "Unknown institution"}${metrics}. ${item.bio || ""}`;
        }
        return `[${i + 1}] ${JSON.stringify(item)}`;
      }).join("\n\n");
      
      let summaryPrompt;
      if (searchIntent === "experts") {
        summaryPrompt = `The user asked for experts/researchers related to "${searchQuery}". I found these ${searchResults.length} experts using OpenAlex academic database. Provide a clear paragraph (3-5 sentences) that introduces these researchers, highlighting their expertise areas, institutional affiliations, and why they are relevant to the query. Use accessible language. Do not list them individually - synthesize into a coherent overview.\n\nExperts found:\n${resultsContext}`;
      } else if (searchIntent === "researcher_publications") {
        summaryPrompt = `The user asked for publications by researcher "${searchQuery}". I found these ${searchResults.length} publications. Provide a clear paragraph (3-5 sentences) that summarizes their research output, key themes across their work, and notable publications. Use accessible language. Do not list them individually - synthesize into a coherent overview.\n\nPublications:\n${resultsContext}`;
      } else {
        summaryPrompt = `The user asked for ${searchIntent} related to "${searchQuery}". I found these ${searchResults.length} results. Provide a clear paragraph (3-5 sentences) that summarizes the key findings/overview of these ${searchIntent}. Focus on common themes, notable findings, or what users should know. Use accessible language. Do not list them individually - synthesize into a coherent overview.\n\nResults:\n${resultsContext}`;
      }
      
      try {
        const summaryModel = geminiInstance.getGenerativeModel({
          model: CHATBOT_MODELS[0],
          systemInstruction: "You are Yori, a health research assistant. Summarize search results concisely in a paragraph. Be accurate and accessible.",
        });
        const summaryResult = await summaryModel.generateContent(summaryPrompt);
        const summaryText = summaryResult?.response?.text?.() ?? "";
        
        if (summaryText) {
          res.write(`data: ${JSON.stringify({ text: summaryText })}\n\n`);
        }
      } catch (summaryErr) {
        console.warn("[Chatbot] AI summary failed, sending intro only:", summaryErr.message);
        const label = searchIntent === "researcher_publications" ? `publications by "${searchQuery}"` : `${searchIntent} related to "${searchQuery}"`;
        const introMessage = `I found ${searchResults.length} ${label}. Here they are:`;
        res.write(`data: ${JSON.stringify({ text: introMessage })}\n\n`);
      }
      
      // Send structured search results (cards) - use cardType so researcher_publications renders as publication cards
      res.write(`data: ${JSON.stringify({ 
        searchResults: {
          type: cardType,
          query: searchQuery,
          items: searchResults
        }
      })}\n\n`);
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
      res.end();
      return;
    } else {
      console.log(`[Chatbot] ${itemContext ? 'Item context detected' : 'No search results found'}, generating AI response`);
    }

    // If asking about a specific trial, send trialDetails with showCard: false so AI response is shown (not raw card)
    if (itemContext?.type === "trial" && itemContext?.item) {
      const t = itemContext.item;
      const trialUrl = t.url || t.clinicalTrialsGovUrl || `https://clinicaltrials.gov/study/${t.nctId || t.id}`;
      const trialDetails = {
        showCard: false,
        nctId: t.nctId || t.id,
        title: t.title || t.briefTitle || t.officialTitle || "Unknown",
        url: trialUrl,
      };
      res.write(`data: ${JSON.stringify({ trialDetails })}\n\n`);
    }

    // If asking about a specific publication, always send publicationDetails so "Ask more" options are shown.
    // showFullCard: true for summarize (show card, hide AI); false for methods/takeaways (show AI + compact Ask more bar).
    if (itemContext?.type === "publication" && itemContext?.item) {
      const p = itemContext.item;
      const authorsStr = Array.isArray(p.authors) ? p.authors.join(", ") : (p.authors || "Unknown");
      const showFullCard = detectPublicationSummaryFocus(userQuery);
      const publicationDetails = {
        showFullCard,
        title: p.title || "Unknown",
        pmid: p.pmid || p.id,
        url: p.url || p.link || (p.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/` : null),
        authors: authorsStr,
        journal: p.journal || "Unknown",
        year: p.year || "Unknown",
        abstract: p.fullAbstract || p.abstract || null,
        keywords: Array.isArray(p.keywords) ? p.keywords.join(", ") : (p.keywords || null),
        publicationTypes: Array.isArray(p.publicationTypes) ? p.publicationTypes.join(", ") : null,
      };
      res.write(`data: ${JSON.stringify({ publicationDetails })}\n\n`);
    }

    // Generate AI response (with item context if available)
    let enhancedQuery = userQuery;
    
    // If user is asking about a specific item, enhance the query with item details
    // Also add instruction to NOT include external links when context is provided
    if (itemContext && itemContext.item && Object.keys(itemContext.item).length > 0) {
      enhancedQuery = userQuery + buildItemContext(itemContext);
    } else if (itemContext && itemContext.type) {
      // Context provided but item might be empty - still add instruction to not include links
      const noLinksInstruction = itemContext.type === "trial" 
        ? "\n\n[Important: The user is viewing a specific trial page. Do NOT include links to ClinicalTrials.gov or any external sites in your response. Answer their question directly using the information available. Do not mention visiting external websites.]"
        : "\n\n[Important: The user is viewing a specific publication page. Do NOT include links to PubMed or any external sites in your response. Answer their question directly using the information available. Do not mention visiting external websites.]";
      enhancedQuery = userQuery + noLinksInstruction;
    }

    for (const modelName of CHATBOT_MODELS) {
      try {
        const model = geminiInstance.getGenerativeModel({
          model: modelName,
          systemInstruction: getSystemPrompt(isFirstMessage),
        });
        const chat = model.startChat({
          history: chatHistory,
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.35,
            topP: 0.85,
            topK: 32,
          },
        });
        const result = await chat.sendMessageStream(enhancedQuery);
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          if (chunkText) {
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
          }
        }
        break;
      } catch (modelErr) {
        console.warn(`[Chatbot] Model ${modelName} failed:`, modelErr.message);
        if (modelName === CHATBOT_MODELS[CHATBOT_MODELS.length - 1]) throw modelErr;
      }
    }

    // Send completion signal
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error("Error generating chat response:", error);
    
    // Try alternate API key if available
    if (genAI && genAI2) {
      try {
        const alternateInstance = getGeminiInstance(true);
        
        // Filter out the initial assistant greeting
        // When context is provided, limit history to matching context messages
        let filteredMessages = messages.slice(0, -1);
        
        if (itemContext && itemContext.item) {
          const currentItemId = itemContext.item.nctId || itemContext.item.id || itemContext.item.pmid;
          filteredMessages = filteredMessages.filter((msg, index) => {
            if (index === 0 && msg.role === "assistant") {
              return false;
            }
            if (msg.role === "user" && msg.context && msg.context.item) {
              const msgItemId = msg.context.item.nctId || msg.context.item.id || msg.context.item.pmid;
              return msgItemId === currentItemId;
            }
            return true;
          });
        } else {
          filteredMessages = filteredMessages.filter((msg, index) => {
            if (index === 0 && msg.role === "assistant") {
              return false;
            }
            return true;
          });
        }
        
        const chatHistory = filteredMessages.map(msg => ({
          role: msg.role === "assistant" ? "model" : "user",
          parts: [{ text: msg.content }],
        }));

        // Check if this is the first user message (no previous user messages in history)
        const hasPreviousUserMessages = filteredMessages.some(msg => msg.role === "user");
        const isFirstMessage = !hasPreviousUserMessages;

        const model = alternateInstance.getGenerativeModel({
          model: "gemini-2.5-flash",
          systemInstruction: getSystemPrompt(isFirstMessage),
        });

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

        // If asking about a specific trial, send trialDetails with showCard: false (show AI response + Ask more bar)
        if (itemContext?.type === "trial" && itemContext?.item) {
          const t = itemContext.item;
          const trialUrl = t.url || t.clinicalTrialsGovUrl || `https://clinicaltrials.gov/study/${t.nctId || t.id}`;
          const trialDetails = {
            showCard: false,
            nctId: t.nctId || t.id,
            title: t.title || t.briefTitle || t.officialTitle || "Unknown",
            url: trialUrl,
          };
          res.write(`data: ${JSON.stringify({ trialDetails })}\n\n`);
        }

        // If we have search results, send them as structured data and skip AI generation
        if (searchResults && Array.isArray(searchResults) && searchResults.length > 0 && !itemContext) {
          console.log(`[Chatbot] Retry: Sending ${searchResults.length} structured ${searchIntent} results`);
          
          // Send structured search results FIRST
          res.write(`data: ${JSON.stringify({ 
            searchResults: {
              type: searchIntent,
              query: searchQuery,
              items: searchResults
            }
          })}\n\n`);
          
          // Send a brief intro message (no AI generation needed)
          const introMessage = `I found ${searchResults.length} ${searchIntent} related to "${searchQuery}". Here they are:`;
          res.write(`data: ${JSON.stringify({ text: introMessage })}\n\n`);
          
          // Send completion signal immediately
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          res.end();
          return;
        }

        // Generate AI response with item context if available
        let enhancedQuery = userQuery;
        if (itemContext && itemContext.item && Object.keys(itemContext.item).length > 0) {
          enhancedQuery = userQuery + buildItemContext(itemContext);
        } else if (itemContext && itemContext.type) {
          // Context provided but item might be empty - still add instruction to not include links
          const noLinksInstruction = itemContext.type === "trial" 
            ? "\n\n[Important: The user is viewing a specific trial page. Do NOT include links to ClinicalTrials.gov or any external sites in your response. Answer their question directly using the information available. Do not mention visiting external websites.]"
            : "\n\n[Important: The user is viewing a specific publication page. Do NOT include links to PubMed or any external sites in your response. Answer their question directly using the information available. Do not mention visiting external websites.]";
          enhancedQuery = userQuery + noLinksInstruction;
        }

        const chat = model.startChat({
          history: chatHistory,
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.35,
            topP: 0.85,
            topK: 32,
          },
        });

        const result = await chat.sendMessageStream(enhancedQuery);

        // Stream the response
        for await (const chunk of result.stream) {
          const chunkText = chunk.text();
          if (chunkText) {
            res.write(`data: ${JSON.stringify({ text: chunkText })}\n\n`);
          }
        }

        res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
        res.end();
        return;
      } catch (retryError) {
        console.error("Retry with alternate API key also failed:", retryError);
      }
    }

    // Send error to client in stream format
    const errMsg = error.message?.includes("API key") ? "Chatbot API configuration issue. Please contact support." : "Failed to generate response. Please try again.";
    if (!res.headersSent) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
    }
    res.write(`data: ${JSON.stringify({ error: errMsg })}\n\n`);
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  }
}

/**
 * Generate suggested prompts - personalized by condition/medical interest when provided
 * @param {string} userRole - "patient" | "researcher"
 * @param {string} [condition] - First medical condition/interest (e.g. "Diabetes", "Parkinson's")
 */
export function generateSuggestedPrompts(userRole = "patient", condition = null) {
  const c = condition && String(condition).trim() ? condition.trim() : null;

  if (c) {
    const personalized = [
      `Show me publications on ${c}`,
      `Show me recent trials for ${c}`,
      `Find experts in ${c}`,
      `What are the latest research findings on ${c}?`,
      `Trends in the latest ${c} research`,
    ];
    return personalized;
  }

  const patientPrompts = [
    "Find clinical trials for my condition",
    "Find experts in my area of interest",
    "Help me understand this medical term",
  ];

  const researcherPrompts = [
    "Show me ongoing trials in neuroscience",
    "Find collaborators in my research area",
    "Explain this research methodology",
  ];

  return userRole === "researcher" ? researcherPrompts : patientPrompts;
}
