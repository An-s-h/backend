import { Router } from "express";
import { ReadItem } from "../models/ReadItem.js";

const router = Router();

// Mark an item as read
router.post("/read/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { type, itemId } = req.body || {};

    if (!type || !itemId) {
      return res.status(400).json({ error: "type and itemId are required" });
    }

    if (!["trial", "publication"].includes(type)) {
      return res.status(400).json({ error: "type must be 'trial' or 'publication'" });
    }

    // Use upsert to create or update (if already exists, just update readAt)
    await ReadItem.findOneAndUpdate(
      { userId, type, itemId },
      { readAt: new Date() },
      { upsert: true, new: true }
    );

    res.json({ ok: true, message: "Item marked as read" });
  } catch (error) {
    console.error("Error marking item as read:", error);
    res.status(500).json({ error: "Failed to mark item as read" });
  }
});

// Get read status for multiple items
router.post("/read/:userId/status", async (req, res) => {
  try {
    const { userId } = req.params;
    const { items } = req.body || {}; // Array of { type, itemId }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items must be an array" });
    }

    // Build query to find all read items
    const readItems = await ReadItem.find({
      userId,
      $or: items.map((item) => ({
        type: item.type,
        itemId: String(item.itemId), // Ensure string comparison
      })),
    });

    // Create a map for quick lookup
    const readMap = new Map();
    readItems.forEach((readItem) => {
      const key = `${readItem.type}:${readItem.itemId}`;
      readMap.set(key, true);
    });

    // Build response with read status for each item
    const statusMap = {};
    items.forEach((item) => {
      const key = `${item.type}:${String(item.itemId)}`;
      statusMap[key] = readMap.has(key);
    });

    res.json({ readStatus: statusMap });
  } catch (error) {
    console.error("Error fetching read status:", error);
    res.status(500).json({ error: "Failed to fetch read status" });
  }
});

// Get all read items for a user
router.get("/read/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const { type } = req.query; // Optional filter by type

    const query = { userId };
    if (type && ["trial", "publication"].includes(type)) {
      query.type = type;
    }

    const readItems = await ReadItem.find(query)
      .sort({ readAt: -1 })
      .select("type itemId readAt");

    res.json({ items: readItems });
  } catch (error) {
    console.error("Error fetching read items:", error);
    res.status(500).json({ error: "Failed to fetch read items" });
  }
});

export default router;

