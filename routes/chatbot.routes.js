import { Router } from "express";
import { generateChatResponse, generateSuggestedPrompts } from "../services/chatbot.service.js";

const router = Router();

/**
 * POST /api/chatbot/chat
 * Stream chat responses using Gemini
 */
router.post("/chatbot/chat", async (req, res) => {
  try {
    const { messages } = req.body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Messages array is required" });
    }

    // Validate message format
    const isValid = messages.every(
      msg => msg.role && msg.content && 
      (msg.role === "user" || msg.role === "assistant")
    );

    if (!isValid) {
      return res.status(400).json({ 
        error: "Invalid message format. Each message must have role and content" 
      });
    }

    // Pass req object for user context (if needed in future)
    await generateChatResponse(messages, res, req);
  } catch (error) {
    console.error("Error in chat endpoint:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

/**
 * GET /api/chatbot/suggestions
 * Get suggested prompts based on user role
 */
router.get("/chatbot/suggestions", (req, res) => {
  try {
    const userRole = req.query.role || "patient";
    const suggestions = generateSuggestedPrompts(userRole);
    res.json({ suggestions });
  } catch (error) {
    console.error("Error getting suggestions:", error);
    res.status(500).json({ error: "Failed to get suggestions" });
  }
});

export default router;
