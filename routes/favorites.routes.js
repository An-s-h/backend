import { Router } from "express";
import { Favorite } from "../models/Favorite.js";
import { fetchDataFromUrl } from "../services/urlParser.service.js";

const router = Router();

router.get("/favorites/:userId", async (req, res) => {
  const { userId } = req.params;
  const docs = await Favorite.find({ userId }).sort({ createdAt: -1 });
  res.json({ items: docs });
});

router.post("/favorites/:userId", async (req, res) => {
  const { userId } = req.params;
  const { type, item } = req.body || {};
  
  // Get item ID from various possible fields
  // For experts, prioritize name, then other IDs
  let itemId = item?.id || item?._id || item?.threadId || item?.orcid || item?.pmid || item?.userId;
  if (type === "expert" && item?.name) {
    itemId = item.name; // Use name as primary ID for experts
  }
  
  if (!type || !itemId)
    return res.status(400).json({ error: "type and item id required" });
  
  // Normalize item to always have id field
  const normalizedItem = {
    ...item,
    id: itemId,
    _id: item._id || itemId,
  };
  
  // Check if favorite already exists (check multiple ID fields)
  const existsQuery = {
    userId,
    type,
    $or: [
      { "item.id": itemId },
      { "item._id": itemId },
      { "item.threadId": itemId },
      { "item.orcid": itemId },
      { "item.pmid": itemId },
    ]
  };
  
  // For experts, also check by name (exact match)
  if (type === "expert" && item?.name) {
    existsQuery.$or.push({ "item.name": item.name });
  }
  
  // For forum/thread types, also check the alternate type
  if (type === "forum" || type === "thread") {
    existsQuery.type = { $in: ["forum", "thread"] };
  }
  
  const exists = await Favorite.findOne(existsQuery);
  
  if (exists) return res.json({ ok: true });
  await Favorite.create({ userId, type, item: normalizedItem });
  res.json({ ok: true });
});

router.delete("/favorites/:userId", async (req, res) => {
  const { userId } = req.params;
  const { type, id } = req.query;
  if (!type || !id)
    return res.status(400).json({ error: "type and id required" });
  
  // Delete by checking multiple ID fields
  // For experts, also check by name (exact match)
  const deleteQuery = {
    userId,
    type,
    $or: [
      { "item.id": id },
      { "item._id": id },
      { "item.threadId": id },
      { "item.orcid": id },
      { "item.pmid": id },
    ]
  };
  
  // For experts, also check by name (exact match)
  if (type === "expert") {
    deleteQuery.$or.push({ "item.name": id });
  }
  
  // For forum/thread types, allow matching between both types
  if (type === "forum" || type === "thread") {
    deleteQuery.type = { $in: ["forum", "thread"] };
  }
  
  await Favorite.deleteOne(deleteQuery);
  res.json({ ok: true });
});

// Add favorite by URL
router.post("/favorites/:userId/add-by-url", async (req, res) => {
  const { userId } = req.params;
  const { url } = req.body || {};

  if (!url) {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    // Fetch data from URL
    const result = await fetchDataFromUrl(url);

    if (!result.success) {
      return res.status(400).json({ error: result.error });
    }

    const { type, data } = result;

    // Determine item ID
    let itemId;
    if (type === "trial") {
      itemId = data.id || data._id;
    } else if (type === "publication") {
      itemId = data.pmid || data.id || data._id;
    } else {
      return res.status(400).json({ error: "Unsupported type" });
    }

    if (!itemId) {
      return res.status(400).json({ error: "Could not determine item ID" });
    }

    // Normalize item to always have id field
    const normalizedItem = {
      ...data,
      id: itemId,
      _id: data._id || itemId,
    };

    // Check if favorite already exists
    const existsQuery = {
      userId,
      type,
      $or: [
        { "item.id": itemId },
        { "item._id": itemId },
      ],
    };

    // For publications, also check by pmid
    if (type === "publication" && data.pmid) {
      existsQuery.$or.push({ "item.pmid": data.pmid });
    }

    const exists = await Favorite.findOne(existsQuery);

    if (exists) {
      return res.json({ 
        ok: true, 
        message: "Item is already in your favorites",
        item: normalizedItem,
        type,
      });
    }

    // Create favorite with addedByUrl flag
    await Favorite.create({ 
      userId, 
      type, 
      item: normalizedItem,
      addedByUrl: true, // Mark as added by URL
    });
    
    res.json({ 
      ok: true, 
      message: "Item added to favorites successfully",
      item: normalizedItem,
      type,
    });
  } catch (error) {
    console.error("Error adding favorite by URL:", error);
    res.status(500).json({ error: "Failed to add favorite. Please try again." });
  }
});

export default router;
