/**
 * Gemini API Rate Limiter and Request Queue
 * 
 * Prevents rate limit errors by:
 * 1. Queueing requests with max concurrency control
 * 2. Enforcing RPM (requests per minute) limits per model
 * 3. Circuit breaker pattern - stops requests when rate limited
 * 4. Exponential backoff on errors
 */

// Rate limits per model (based on your Gemini API quotas)
const MODEL_LIMITS = {
  'gemini-2-flash-exp': { rpm: 9, tpm: 240000 }, // Set slightly below actual limit (10 RPM, 250K TPM) for safety margin
  'gemini-2.5-flash-lite': { rpm: 3800, tpm: 3800000 }, // Set slightly below actual limit (4K RPM, 4M TPM) for safety
  'gemini-2.5-flash': { rpm: 950, tpm: 950000 }, // Set slightly below actual limit (1K RPM, 1M TPM) for safety
  'gemini-2-flash': { rpm: 1900, tpm: 3800000 }, // Set slightly below actual limit (2K RPM, 4M TPM) for safety
  'gemini-3-flash': { rpm: 950, tpm: 950000 }, // Set slightly below actual limit (1K RPM, 1M TPM) for safety
};

// Default to most conservative limit if model not found
const DEFAULT_LIMIT = { rpm: 8, tpm: 200000 };

class GeminiRateLimiter {
  constructor() {
    // Track requests per model per minute
    this.requestTimestamps = new Map(); // model -> array of timestamps
    this.tokenCounts = new Map(); // model -> array of { timestamp, tokens }
    
    // Circuit breaker state per model
    this.circuitState = new Map(); // model -> { isOpen, openedAt, failureCount }
    this.CIRCUIT_OPEN_DURATION = 60000; // 60 seconds
    this.CIRCUIT_FAILURE_THRESHOLD = 3; // Open circuit after 3 consecutive failures
    
    // Request queue per model
    this.queues = new Map(); // model -> array of pending requests
    this.processing = new Map(); // model -> number of currently processing requests
    this.MAX_CONCURRENT = 3; // Max concurrent requests per model
    
    // Clean up old timestamps every minute
    setInterval(() => this.cleanup(), 60000);
  }

  /**
   * Get rate limit for a model
   */
  getLimit(model) {
    // Normalize model name
    const normalizedModel = model?.toLowerCase() || '';
    
    // Check exact match first
    if (MODEL_LIMITS[normalizedModel]) {
      return MODEL_LIMITS[normalizedModel];
    }
    
    // Check partial match
    for (const [key, limit] of Object.entries(MODEL_LIMITS)) {
      if (normalizedModel.includes(key) || key.includes(normalizedModel)) {
        return limit;
      }
    }
    
    return DEFAULT_LIMIT;
  }

  /**
   * Check if circuit is open (too many failures)
   */
  isCircuitOpen(model) {
    const state = this.circuitState.get(model);
    if (!state || !state.isOpen) return false;
    
    // Check if circuit should be closed (cooldown period over)
    const now = Date.now();
    if (now - state.openedAt > this.CIRCUIT_OPEN_DURATION) {
      this.circuitState.set(model, { isOpen: false, openedAt: 0, failureCount: 0 });
      console.log(`✅ Circuit closed for ${model} - cooldown period over`);
      return false;
    }
    
    return true;
  }

  /**
   * Record a failure and potentially open circuit
   */
  recordFailure(model) {
    const state = this.circuitState.get(model) || { isOpen: false, openedAt: 0, failureCount: 0 };
    state.failureCount++;
    
    if (state.failureCount >= this.CIRCUIT_FAILURE_THRESHOLD) {
      state.isOpen = true;
      state.openedAt = Date.now();
      console.warn(`🔴 Circuit opened for ${model} - too many failures (${state.failureCount})`);
    }
    
    this.circuitState.set(model, state);
  }

  /**
   * Record a success and reset failure count
   */
  recordSuccess(model) {
    const state = this.circuitState.get(model);
    if (state) {
      state.failureCount = 0;
      this.circuitState.set(model, state);
    }
  }

  /**
   * Check if we can make a request without exceeding rate limits
   */
  canMakeRequest(model, estimatedTokens = 1000) {
    // Check circuit breaker first
    if (this.isCircuitOpen(model)) {
      return { allowed: false, reason: 'circuit_open', waitTime: this.CIRCUIT_OPEN_DURATION };
    }
    
    const limit = this.getLimit(model);
    const now = Date.now();
    const oneMinuteAgo = now - 60000;
    
    // Get recent requests
    const timestamps = this.requestTimestamps.get(model) || [];
    const recentRequests = timestamps.filter(t => t > oneMinuteAgo);
    
    // Check RPM limit
    if (recentRequests.length >= limit.rpm) {
      const oldestRequest = Math.min(...recentRequests);
      const waitTime = 60000 - (now - oldestRequest) + 1000; // Add 1s buffer
      return { allowed: false, reason: 'rpm_exceeded', waitTime, current: recentRequests.length, limit: limit.rpm };
    }
    
    // Check TPM limit (optional - more conservative)
    const tokenData = this.tokenCounts.get(model) || [];
    const recentTokens = tokenData.filter(t => t.timestamp > oneMinuteAgo);
    const totalTokens = recentTokens.reduce((sum, t) => sum + t.tokens, 0);
    
    if (totalTokens + estimatedTokens > limit.tpm) {
      const oldestTokenRequest = Math.min(...recentTokens.map(t => t.timestamp));
      const waitTime = 60000 - (now - oldestTokenRequest) + 1000;
      return { allowed: false, reason: 'tpm_exceeded', waitTime, current: totalTokens, limit: limit.tpm };
    }
    
    return { allowed: true };
  }

  /**
   * Record a request
   */
  recordRequest(model, tokens = 1000) {
    const now = Date.now();
    
    // Record timestamp
    const timestamps = this.requestTimestamps.get(model) || [];
    timestamps.push(now);
    this.requestTimestamps.set(model, timestamps);
    
    // Record tokens
    const tokenData = this.tokenCounts.get(model) || [];
    tokenData.push({ timestamp: now, tokens });
    this.tokenCounts.set(model, tokenData);
  }

  /**
   * Clean up old timestamps (older than 1 minute)
   */
  cleanup() {
    const oneMinuteAgo = Date.now() - 60000;
    
    for (const [model, timestamps] of this.requestTimestamps.entries()) {
      const recent = timestamps.filter(t => t > oneMinuteAgo);
      if (recent.length > 0) {
        this.requestTimestamps.set(model, recent);
      } else {
        this.requestTimestamps.delete(model);
      }
    }
    
    for (const [model, tokenData] of this.tokenCounts.entries()) {
      const recent = tokenData.filter(t => t.timestamp > oneMinuteAgo);
      if (recent.length > 0) {
        this.tokenCounts.set(model, recent);
      } else {
        this.tokenCounts.delete(model);
      }
    }
  }

  /**
   * Execute a Gemini API request with rate limiting
   * @param {Function} fn - Async function that makes the API call
   * @param {string} model - Model name
   * @param {number} estimatedTokens - Estimated token count
   * @returns {Promise} Result of the API call
   */
  async execute(fn, model = 'gemini-2.5-flash-lite', estimatedTokens = 1000) {
    return new Promise((resolve, reject) => {
      // Add to queue
      const queue = this.queues.get(model) || [];
      queue.push({ fn, model, estimatedTokens, resolve, reject });
      this.queues.set(model, queue);
      
      // Process queue
      this.processQueue(model);
    });
  }

  /**
   * Process the queue for a model
   */
  async processQueue(model) {
    // Check if already processing max concurrent requests
    const currentlyProcessing = this.processing.get(model) || 0;
    if (currentlyProcessing >= this.MAX_CONCURRENT) {
      return;
    }
    
    const queue = this.queues.get(model) || [];
    if (queue.length === 0) {
      return;
    }
    
    // Get next request from queue
    const request = queue.shift();
    this.queues.set(model, queue);
    
    // Increment processing count
    this.processing.set(model, currentlyProcessing + 1);
    
    try {
      // Wait if rate limited
      await this.waitIfNeeded(request.model, request.estimatedTokens);
      
      // Record request
      this.recordRequest(request.model, request.estimatedTokens);
      
      // Execute the function
      const result = await request.fn();
      
      // Record success
      this.recordSuccess(request.model);
      
      // Resolve promise
      request.resolve(result);
    } catch (error) {
      // Check if it's a rate limit error
      const errorMessage = error.message || String(error);
      const isRateLimitError = 
        errorMessage.includes('429') ||
        errorMessage.includes('rate limit') ||
        errorMessage.includes('quota') ||
        errorMessage.includes('exceeded') ||
        errorMessage.includes('overloaded') ||
        errorMessage.includes('503') ||
        error.status === 429 ||
        error.status === 503;
      
      if (isRateLimitError) {
        console.error(`🔴 Rate limit error for ${request.model}:`, errorMessage);
        this.recordFailure(request.model);
      }
      
      // Reject promise
      request.reject(error);
    } finally {
      // Decrement processing count
      const newCount = Math.max(0, (this.processing.get(model) || 1) - 1);
      this.processing.set(model, newCount);
      
      // Process next item in queue
      setImmediate(() => this.processQueue(model));
    }
  }

  /**
   * Wait if rate limited
   */
  async waitIfNeeded(model, estimatedTokens) {
    let attempts = 0;
    const maxAttempts = 10;
    
    while (attempts < maxAttempts) {
      const check = this.canMakeRequest(model, estimatedTokens);
      
      if (check.allowed) {
        return;
      }
      
      console.log(`⏳ Rate limit reached for ${model} (${check.reason}). Waiting ${Math.ceil(check.waitTime / 1000)}s...`);
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, check.waitTime));
      attempts++;
    }
    
    throw new Error(`Rate limit wait timeout for ${model} after ${maxAttempts} attempts`);
  }

  /**
   * Get current status for debugging
   */
  getStatus() {
    const status = {};
    
    for (const [model, limit] of Object.entries(MODEL_LIMITS)) {
      const oneMinuteAgo = Date.now() - 60000;
      const timestamps = this.requestTimestamps.get(model) || [];
      const recentRequests = timestamps.filter(t => t > oneMinuteAgo);
      
      const tokenData = this.tokenCounts.get(model) || [];
      const recentTokens = tokenData.filter(t => t.timestamp > oneMinuteAgo);
      const totalTokens = recentTokens.reduce((sum, t) => sum + t.tokens, 0);
      
      const circuit = this.circuitState.get(model);
      const queue = this.queues.get(model) || [];
      const processing = this.processing.get(model) || 0;
      
      status[model] = {
        rpm: {
          current: recentRequests.length,
          limit: limit.rpm,
          usage: `${Math.round((recentRequests.length / limit.rpm) * 100)}%`,
        },
        tpm: {
          current: totalTokens,
          limit: limit.tpm,
          usage: `${Math.round((totalTokens / limit.tpm) * 100)}%`,
        },
        circuit: {
          isOpen: circuit?.isOpen || false,
          failures: circuit?.failureCount || 0,
        },
        queue: {
          pending: queue.length,
          processing: processing,
        },
      };
    }
    
    return status;
  }
}

// Singleton instance
const rateLimiter = new GeminiRateLimiter();

export default rateLimiter;
