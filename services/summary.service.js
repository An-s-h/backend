import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

// Load environment variables before creating the instance
dotenv.config();

// Get API key from environment variable
const apiKey = process.env.GOOGLE_AI_API_KEY;

if (!apiKey) {
  console.warn(
    "⚠️  GOOGLE_AI_API_KEY not found in environment variables. AI features will use fallback."
  );
}

const genAI = new GoogleGenerativeAI(apiKey || "");
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

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    // For publications, generate structured summary
    if (type === "publication") {
      const languageInstruction = simplify
        ? "Summarize this research publication in plain language for patients. Use simple words and short sentences."
        : "Summarize this research publication for researchers and medical professionals. Use appropriate technical terminology and research language.";
      
      const prompt = `You are a medical research expert. ${languageInstruction} Structure your response as a JSON object with these sections:

{
  "coreMessage": "The most important finding in 1-2 sentences (what they discovered)",
  "what": "What the study was about - describe the research question/problem (2-3 sentences)",
  "why": "Why this research matters - explain the importance and context (2-3 sentences)",
  "how": "How they did the study - describe the methods (2-3 sentences)",
  "soWhat": "So what does this mean? - explain relevance, implications, and significance (2-3 sentences)",
  "keyTakeaway": "One sentence takeaway that should be remembered"
}

Publication content: ${text.substring(0, 2000)}

Return ONLY valid JSON, no markdown formatting.${simplify ? " Use plain language throughout - avoid jargon." : " Use appropriate technical and scientific terminology."}`;

      const result = await model.generateContent(prompt);
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
      ? "Summarize the following medical content in 3-4 sentences using simple, plain language for patients. Focus on key findings and relevance."
      : "Summarize the following medical content in 3-4 sentences using appropriate technical and scientific terminology for researchers. Focus on key findings, methodology, and clinical relevance.";
    
    const result = await model.generateContent(
      `${languageInstruction}: ${text}`
    );
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });
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

  // Fallback if API key missing - just truncate
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    const words = title.split(" ");
    if (words.length <= 10) {
      return title;
    }
    // Return first 10 words with ellipsis
    return words.slice(0, 10).join(" ") + "...";
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

    const prompt = `Simplify this medical research publication title to make it easier to understand for patients. Keep the core meaning and main topic, but use simpler words and shorter phrases. The simplified title should be concise (aim for 8-12 words or 60-80 characters max) while preserving the essential information about what the study is about.

Original title: "${title}"

Return ONLY the simplified title, no explanations, no quotes, no markdown formatting. Just the simplified title text.`;

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
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

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
export async function generateTrialDetails(trial, section = "all", simplify = false) {
  // Fallback if API key missing
  const apiKey = process.env.GOOGLE_AI_API_KEY;
  if (!apiKey) {
    return {
      procedures: "Detailed information about study procedures, schedule, and treatments is available on the ClinicalTrials.gov website.",
      risksBenefits: "Information about potential risks and benefits associated with this clinical trial is available on the ClinicalTrials.gov website. Please review this information carefully before deciding to participate.",
      participantRequirements: "Specific requirements and expectations for participants, including visits, tests, and follow-up procedures, are detailed on the ClinicalTrials.gov website.",
    };
  }

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

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
    const sectionsToGenerate = section === "all" 
      ? ["procedures", "risksBenefits", "participantRequirements"]
      : [section];

    const result = {};

    // Generate procedures, schedule, and treatments
    if (sectionsToGenerate.includes("procedures")) {
      const languageInstruction = simplify
        ? "explain in plain language what happens during this trial - including procedures, schedule, and treatments. Write this for patients in simple, clear language (3-4 sentences)"
        : "explain what happens during this trial - including procedures, schedule, and treatments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences)";
      
      const proceduresPrompt = `You are a medical research expert. Based on the clinical trial information provided, ${languageInstruction}. If specific details are not available, provide a general explanation based on the trial phase and type.

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
        ? "explain in plain language the potential risks and benefits of participating in this clinical trial. Write this for patients in simple, clear language (3-4 sentences)"
        : "explain the potential risks and benefits of participating in this clinical trial. Write this for researchers using appropriate technical terminology and clinical language (3-4 sentences)";
      
      const risksBenefitsPrompt = `You are a medical research expert. Based on the clinical trial information provided, ${languageInstruction}. Be balanced and informative.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`;

      const risksBenefitsResult = await model.generateContent(risksBenefitsPrompt, {
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.7,
        },
      });
      result.risksBenefits = risksBenefitsResult.response.text().trim();
    }

    // Generate participant requirements
    if (sectionsToGenerate.includes("participantRequirements")) {
      const languageInstruction = simplify
        ? "explain in plain language what participants need to do - including visits, tests, follow-up procedures, and time commitments. Write this for patients in simple, clear language (3-4 sentences)"
        : "explain what participants need to do - including visits, tests, follow-up procedures, and time commitments. Write this for researchers using appropriate technical terminology and research language (3-4 sentences)";
      
      const requirementsPrompt = `You are a medical research expert. Based on the clinical trial information provided, ${languageInstruction}.

Trial Information:
- Title: ${trialInfo.title}
- Phase: ${trialInfo.phase}
- Conditions: ${trialInfo.conditions}
- Description: ${trialInfo.description.substring(0, 500)}
- Eligibility: ${trialInfo.eligibility.substring(0, 300)}
- Location: ${trialInfo.location}

Return ONLY the explanation text, no markdown formatting, no labels, just the explanation.`;

      const requirementsResult = await model.generateContent(requirementsPrompt, {
        generationConfig: {
          maxOutputTokens: 300,
          temperature: 0.7,
        },
      });
      result.participantRequirements = requirementsResult.response.text().trim();
    }

    return result;
  } catch (e) {
    console.error("AI trial details generation error:", e);
    // Fallback
    return {
      procedures: "Detailed information about study procedures, schedule, and treatments is available on the ClinicalTrials.gov website.",
      risksBenefits: "Information about potential risks and benefits associated with this clinical trial is available on the ClinicalTrials.gov website. Please review this information carefully before deciding to participate.",
      participantRequirements: "Specific requirements and expectations for participants, including visits, tests, and follow-up procedures, are detailed on the ClinicalTrials.gov website.",
    };
  }
}