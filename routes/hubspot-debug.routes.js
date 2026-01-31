import express from "express";
import dotenv from "dotenv";

const router = express.Router();

// Debug endpoint to check HubSpot configuration
// Remove this route in production for security
router.get("/hubspot/debug", (req, res) => {
  // Reload .env file
  dotenv.config();

  const portalId = process.env.HUBSPOT_PORTAL_ID;
  const formGuid = process.env.HUBSPOT_FORM_GUID;

  res.json({
    configured: !!(portalId && formGuid),
    hasPortalId: !!portalId,
    hasFormGuid: !!formGuid,
    portalIdLength: portalId?.length || 0,
    formGuidLength: formGuid?.length || 0,
    portalIdPreview: portalId
      ? `${portalId.substring(0, 4)}...${portalId.substring(portalId.length - 4)}`
      : "NOT SET",
    formGuidPreview: formGuid
      ? `${formGuid.substring(0, 8)}...${formGuid.substring(formGuid.length - 8)}`
      : "NOT SET",
    envFileLocation: "Should be in: server/.env",
    allEnvKeys: Object.keys(process.env)
      .filter((key) => key.includes("HUBSPOT"))
      .map((key) => ({
        key,
        hasValue: !!process.env[key],
        valueLength: process.env[key]?.length || 0,
      })),
  });
});

export default router;

