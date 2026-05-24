/**
 * Retry queue for dead letter messages.
 * Tracks retry attempts with exponential backoff and max limits per category.
 */
class RetryQueue {
  constructor(logger, opts = {}) {
    this.logger = logger;
    this.maxRetries = opts.maxRetries || 3;
    this.baseDelayMs = opts.baseDelayMs || 2000;
    this.pending = new Map();
    this.stats = {
      totalReceived: 0,
      totalRetried: 0,
      totalExhausted: 0,
      totalSucceeded: 0,
      byCategory: {},
    };
  }

  _categoryStats(category) {
    if (!this.stats.byCategory[category]) {
      this.stats.byCategory[category] = { received: 0, retried: 0, exhausted: 0 };
    }
    return this.stats.byCategory[category];
  }

  /**
   * Enqueue a dead letter for retry evaluation.
   * Returns { shouldRetry, attempt, delayMs } or { shouldRetry: false, reason }.
   */
  evaluate(deadLetter) {
    const id = deadLetter.dead_letter_id;
    const category = deadLetter.category || 'unknown';
    this.stats.totalReceived += 1;
    this._categoryStats(category).received += 1;

    // Only retry processing failures — malformed/invalid payloads are permanent
    if (category.includes('malformed') || category.includes('invalid')) {
      return { shouldRetry: false, reason: 'permanent-failure' };
    }

    const existing = this.pending.get(id);
    const attempt = existing ? existing.attempt + 1 : 1;

    if (attempt > this.maxRetries) {
      this.pending.delete(id);
      this.stats.totalExhausted += 1;
      this._categoryStats(category).exhausted += 1;
      this.logger.warn({ id, category, attempt }, 'DLQ message exhausted all retries');
      return { shouldRetry: false, reason: 'max-retries-exceeded' };
    }

    const delayMs = this.baseDelayMs * Math.pow(2, attempt - 1);
    this.pending.set(id, { attempt, category, enqueuedAt: Date.now() });
    this.stats.totalRetried += 1;
    this._categoryStats(category).retried += 1;

    return { shouldRetry: true, attempt, delayMs };
  }

  markSuccess(id) {
    this.pending.delete(id);
    this.stats.totalSucceeded += 1;
  }

  getStats() {
    return {
      ...this.stats,
      pendingCount: this.pending.size,
    };
  }
}

module.exports = { RetryQueue };
