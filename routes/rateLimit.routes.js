import { Router } from "express";
import rateLimiter from "../utils/geminiRateLimiter.js";

const router = Router();

/**
 * GET /api/rate-limit/status
 * Get current rate limiter status for all models
 */
router.get("/status", (req, res) => {
  try {
    const status = rateLimiter.getStatus();
    
    // Calculate overall health
    let overallHealth = "healthy";
    let warnings = [];
    
    for (const [model, stats] of Object.entries(status)) {
      const rpmUsage = (stats.rpm.current / stats.rpm.limit) * 100;
      const tpmUsage = (stats.tpm.current / stats.tpm.limit) * 100;
      
      if (stats.circuit.isOpen) {
        overallHealth = "critical";
        warnings.push(`${model}: Circuit breaker is open`);
      } else if (rpmUsage > 90 || tpmUsage > 90) {
        if (overallHealth !== "critical") overallHealth = "warning";
        warnings.push(`${model}: Usage above 90% (RPM: ${Math.round(rpmUsage)}%, TPM: ${Math.round(tpmUsage)}%)`);
      } else if (rpmUsage > 70 || tpmUsage > 70) {
        if (overallHealth === "healthy") overallHealth = "warning";
        warnings.push(`${model}: Usage above 70% (RPM: ${Math.round(rpmUsage)}%, TPM: ${Math.round(tpmUsage)}%)`);
      }
    }
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      overallHealth,
      warnings,
      models: status,
    });
  } catch (error) {
    console.error("Error getting rate limiter status:", error);
    res.status(500).json({
      success: false,
      error: "Failed to get rate limiter status",
    });
  }
});

/**
 * GET /api/rate-limit/health
 * Simple health check endpoint
 */
router.get("/health", (req, res) => {
  try {
    const status = rateLimiter.getStatus();
    
    // Check if any circuit breakers are open
    const openCircuits = Object.entries(status)
      .filter(([_, stats]) => stats.circuit.isOpen)
      .map(([model, _]) => model);
    
    // Check if any models are over 90% usage
    const highUsage = Object.entries(status)
      .filter(([_, stats]) => {
        const rpmUsage = (stats.rpm.current / stats.rpm.limit) * 100;
        const tpmUsage = (stats.tpm.current / stats.tpm.limit) * 100;
        return rpmUsage > 90 || tpmUsage > 90;
      })
      .map(([model, _]) => model);
    
    const isHealthy = openCircuits.length === 0 && highUsage.length === 0;
    
    res.status(isHealthy ? 200 : 503).json({
      success: isHealthy,
      healthy: isHealthy,
      openCircuits,
      highUsage,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Error checking rate limiter health:", error);
    res.status(500).json({
      success: false,
      healthy: false,
      error: "Failed to check health",
    });
  }
});

export default router;
