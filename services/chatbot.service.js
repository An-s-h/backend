import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
import rateLimiter from "../utils/geminiRateLimiter.js";
import { searchPubMed } from "./pubmed.service.js";
import { searchClinicalTrials } from "./clinicalTrials.service.js";
import { findResearchersWithGemini } from "./geminiExperts.service.js";
import { fetchTrialById, fetchPublicationById } from "./urlParser.service.js";

dotenv.config();

const apiKey = process.env.GOOGLE_AI_API_KEY;
const apiKey2 = process.env.GOOGLE_AI_API_KEY_2;

if (!apiKey && !apiKey2) {
  console.warn("⚠️  No Google AI API keys found for chatbot");
}

const genAI = apiKey ? new GoogleGenerativeAI(apiKey) : null;
const genAI2 = apiKey2 ? new GoogleGenerativeAI(apiKey2) : null;

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
 */
const SYSTEM_PROMPT = `You are iora, the user's personal AI assistant on Collabiora - a comprehensive health research platform. Your role is to help users discover and understand health research information. Always introduce yourself as Iora and refer to the platform as Collabiora.

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
- **When answering questions about specific items (trials, publications, experts), ALWAYS include the source link (ClinicalTrials.gov, PubMed, etc.) for verification**
- **For trial questions, provide specific eligibility criteria when asked about inclusion criteria**
- **For publication questions, cite the PMID and provide the PubMed link**
- **Always base your answers on the provided item details - do not make up information**

## Response Style:

- Be concise but thorough
- Use bullet points for clarity when listing information
- Break down complex medical terms
- Provide context for research findings (e.g., study size, limitations)
- When presenting search results, format them nicely with clear headings and key information
- Use markdown formatting for better readability (bold titles, bullet points, links)
- Encourage users to explore Collabiora's search features for deeper research
- **CRITICAL**: When greeting or introducing yourself (e.g. for "hi", "hey", "hello"), say "I'm Iora" and "Collabiora" - never use "CuraBot" or "CuraLink"

Remember: You're a research assistant, not a replacement for medical advice. Always emphasize the importance of consulting healthcare professionals for personal medical decisions.`;

/**
 * Detect if query is asking for publications, trials, or experts
 */
function detectSearchIntent(query) {
  const lowerQuery = query.toLowerCase();
  
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
    "specialist", "specialists", "find experts", "show experts", "get experts",
    "experts in", "experts on", "experts about", "researchers in",
    "find researcher", "find researchers"
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
    "experts", "expert", "researchers", "researcher",
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
 * Fetch publications from backend
 */
async function fetchPublications(query, limit = 4) {
  try {
    const result = await searchPubMed({
      q: query,
      page: 1,
      pageSize: limit,
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
 */
async function fetchTrials(query, limit = 4) {
  try {
    const result = await searchClinicalTrials({
      q: query,
      page: 1,
      pageSize: limit,
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
 * Fetch experts from backend
 */
async function fetchExperts(query, limit = 4) {
  try {
    const experts = await findResearchersWithGemini(query);
    
    return experts.slice(0, limit).map(expert => ({
      name: expert.name || "Unknown Researcher",
      affiliation: expert.affiliation || expert.university || "Unknown institution",
      location: expert.location || "Unknown location",
      bio: expert.biography || expert.bio || "No biography available",
      researchInterests: expert.researchInterests?.slice(0, 3).join(", ") || "Not specified",
    }));
  } catch (error) {
    console.error("Error fetching experts:", error);
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
    contextInfo += `\n\n[Important: Answer only from the trial details above. Include the NCT ID and link (${trialUrl}) for verification. For inclusion criteria use the Eligibility section; for contact details use the Contact Details and Trial Locations; for participation explain steps and point to contacts/link.]`;
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
    contextInfo += `\n\n[Important: Always provide accurate information based on the publication details above. Include the PMID and link to PubMed for verification. When summarizing, focus on the key findings and methodology.]`;
  } else if (itemContext.type === "expert") {
    contextInfo = `\n\n[User is asking about this specific expert/researcher. Use the following information to answer their question accurately:]\n\n`;
    contextInfo += `Name: ${item.name || "Unknown"}\n`;
    contextInfo += `Affiliation: ${item.affiliation || "Unknown"}\n`;
    contextInfo += `Location: ${item.location || "Unknown"}\n`;
    if (item.bio || item.biography) {
      contextInfo += `\nBiography:\n${item.bio || item.biography}\n`;
    }
    if (item.researchInterests) {
      contextInfo += `\nResearch Interests: ${item.researchInterests}\n`;
    }
    contextInfo += `\n\n[Important: Provide information about this researcher's background, expertise, and contributions based on the details above.]`;
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
  let itemContext = null;
  if (lastMessage.context && lastMessage.context.item) {
    itemContext = lastMessage.context;
    console.log(`[Chatbot] User asking about specific ${itemContext.type}:`, itemContext.item.title || itemContext.item.name);
    
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
  
  // Check if user is asking for publications, trials, or experts
  const searchIntent = detectSearchIntent(userQuery);
  
  let searchResults = null;
  let searchQuery = null;
  
  // If search intent detected and no item context, fetch real data
  if (searchIntent && !itemContext) {
    searchQuery = extractSearchQuery(userQuery, searchIntent);
    console.log(`[Chatbot] Detected ${searchIntent} intent for query: "${searchQuery}"`);
    
    try {
      if (searchIntent === "publications") {
        searchResults = await fetchPublications(searchQuery, 4);
      } else if (searchIntent === "trials") {
        searchResults = await fetchTrials(searchQuery, 4);
      } else if (searchIntent === "experts") {
        searchResults = await fetchExperts(searchQuery, 4);
      }
      
      console.log(`[Chatbot] Fetched ${searchResults?.length || 0} ${searchIntent} results`);
    } catch (error) {
      console.error(`[Chatbot] Error fetching ${searchIntent}:`, error);
      // Continue with AI response even if search fails
      searchResults = null;
    }
  }

  try {
    // Use gemini-2.5-flash for better conversational capabilities
    const model = geminiInstance.getGenerativeModel({
      model: "gemini-2.5-flash",
      systemInstruction: SYSTEM_PROMPT,
    });

    // Convert messages to Gemini format
    // Filter out the initial assistant greeting and only keep actual conversation
    const chatHistory = messages.slice(0, -1)
      .filter((msg, index) => {
        // Skip the first message if it's from assistant (initial greeting)
        if (index === 0 && msg.role === "assistant") {
          return false;
        }
        return true;
      })
      .map(msg => ({
        role: msg.role === "assistant" ? "model" : "user",
        parts: [{ text: msg.content }],
      }));

    // Set headers for SSE (Server-Sent Events)
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // If we have search results, send them as structured data and skip AI generation
    if (searchResults && Array.isArray(searchResults) && searchResults.length > 0 && !itemContext) {
      console.log(`[Chatbot] Sending ${searchResults.length} structured ${searchIntent} results`);
      
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
    } else {
      console.log(`[Chatbot] ${itemContext ? 'Item context detected' : 'No search results found'}, generating AI response`);
    }

    // Generate AI response (with item context if available)
    let enhancedQuery = userQuery;
    
    // If user is asking about a specific item, enhance the query with item details
    if (itemContext && itemContext.item) {
      enhancedQuery = userQuery + buildItemContext(itemContext);
    }

    const chat = model.startChat({
      history: chatHistory,
      generationConfig: {
        maxOutputTokens: 2048,
        temperature: 0.7,
        topP: 0.9,
        topK: 40,
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

    // Send completion signal
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();

  } catch (error) {
    console.error("Error generating chat response:", error);
    
    // Try alternate API key if available
    if (genAI && genAI2) {
      try {
        const alternateInstance = getGeminiInstance(true);
        const model = alternateInstance.getGenerativeModel({
          model: "gemini-2.5-flash",
          systemInstruction: SYSTEM_PROMPT,
        });

        // Filter out the initial assistant greeting
        const chatHistory = messages.slice(0, -1)
          .filter((msg, index) => {
            // Skip the first message if it's from assistant (initial greeting)
            if (index === 0 && msg.role === "assistant") {
              return false;
            }
            return true;
          })
          .map(msg => ({
            role: msg.role === "assistant" ? "model" : "user",
            parts: [{ text: msg.content }],
          }));

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");

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
        if (itemContext && itemContext.item) {
          enhancedQuery = userQuery + buildItemContext(itemContext);
        }

        const chat = model.startChat({
          history: chatHistory,
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.7,
            topP: 0.9,
            topK: 40,
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

    // If all attempts fail, send error
    if (!res.headersSent) {
      res.write(`data: ${JSON.stringify({ error: "Failed to generate response. Please try again." })}\n\n`);
      res.end();
    }
  }
}

/**
 * Generate suggested prompts based on user context
 */
export function generateSuggestedPrompts(userRole = "patient") {
  const patientPrompts = [
    "Find clinical trials for my condition",
    "Explain recent research on cancer treatments",
    "Help me understand this medical term",
    "Find experts in cardiology",
  ];

  const researcherPrompts = [
    "Find recent publications on immunotherapy",
    "Show me ongoing trials in neuroscience",
    "Find collaborators in my research area",
    "Explain this research methodology",
  ];

  return userRole === "researcher" ? researcherPrompts : patientPrompts;
}
