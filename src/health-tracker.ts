/**
 * Lightweight in-memory provider health tracker.
 *
 * Tracks success/failure counts and average latency per provider.
 * Stats reset when the Worker restarts (expected — no persistence needed).
 */

interface ProviderStats {
  successes: number;
  failures: number;
  totalLatency: number;
  lastSuccess: number;
  lastFailure: number;
}

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unhealthy";
  avgLatencyMs: number;
  failureRate: number;
  totalRequests: number;
}

class HealthTracker {
  private stats = new Map<string, ProviderStats>();

  private getStats(provider: string): ProviderStats {
    let s = this.stats.get(provider);
    if (!s) {
      s = { successes: 0, failures: 0, totalLatency: 0, lastSuccess: 0, lastFailure: 0 };
      this.stats.set(provider, s);
    }
    return s;
  }

  /** Record a successful request with its latency. */
  recordSuccess(provider: string, latencyMs: number): void {
    const s = this.getStats(provider);
    s.successes++;
    s.totalLatency += latencyMs;
    s.lastSuccess = Date.now();
  }

  /** Record a failed request. */
  recordFailure(provider: string): void {
    const s = this.getStats(provider);
    s.failures++;
    s.lastFailure = Date.now();
  }

  /** Get the current health snapshot for a provider. */
  getHealth(provider: string): ProviderHealth {
    const s = this.getStats(provider);
    const total = s.successes + s.failures;
    if (total === 0) {
      return { status: "healthy", avgLatencyMs: 0, failureRate: 0, totalRequests: 0 };
    }
    const failureRate = s.failures / total;
    const avgLatency = s.successes > 0 ? s.totalLatency / s.successes : 0;

    let status: ProviderHealth["status"] = "healthy";
    if (failureRate > 0.5) status = "unhealthy";
    else if (failureRate > 0.2) status = "degraded";

    return {
      status,
      avgLatencyMs: Math.round(avgLatency),
      failureRate: Math.round(failureRate * 100) / 100,
      totalRequests: total,
    };
  }
}

/** Singleton shared across the Worker. */
export const healthTracker = new HealthTracker();
