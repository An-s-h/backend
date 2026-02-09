import { Router } from "express";
import { generateChatResponse, generateSuggestedPrompts } from "../services/chatbot.service.js";

const router = Router();

/**
 * POST /api/chatbot/chat
 * Stream chat responses using Gemini
 */
router.post("/chatbot/chat", async (req, res) => {
  try {
    const { messages, context } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    const isValid = messages.every(
      msg => msg.role && (msg.content != null) && 
      (msg.role === "user" || msg.role === "assistant")
    );

    if (!isValid) {
      return res.status(400).json({ 
        error: "Invalid message format. Each message must have role and content" 
      });
    }

    // Pass req object with context for user context (detail pages)
    if (context) {
      req.body.context = context;
    }
    await generateChatResponse(messages, res, req);
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    if (!res.headersSent) {
      const msg = error.message === "Gemini API not configured"
        ? "Chatbot is not configured. Please ensure GOOGLE_AI_API_KEY is set."
        : "Failed to generate response. Please try again.";
      res.status(500).json({ error: msg });
    }
  }
});

/**
 * GET /api/chatbot/suggestions
 * Get suggested prompts - personalized by condition when provided
 * Query: role=patient|researcher, condition=Diabetes (optional - first medical interest)
 */
router.get("/chatbot/suggestions", (req, res) => {
  try {
    const userRole = req.query.role || "patient";
    const condition = req.query.condition || null;
    const suggestions = generateSuggestedPrompts(userRole, condition);
    res.json({ suggestions });
  } catch (error) {
    console.error("Error getting suggestions:", error);
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

export default router;
