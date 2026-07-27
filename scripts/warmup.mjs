#!/usr/bin/env node

/**
 * Cloudflare Worker warmup script.
 *
 * Pings the deployed worker's public endpoints periodically to keep
 * the isolate warm and avoid cold-start latency for real users.
 *
 * Usage:
 *   node scripts/warmup.mjs                   # uses WORKER_URL env var
 *   node scripts/warmup.mjs https://my-worker.example.com
 *   WORKER_URL=https://my-worker.example.com node scripts/warmup.mjs
 *
 * Typical use: run via cron every 5 minutes.
 *   crontab:  */5 * * * * cd /path/to/project && node scripts/warmup.mjs
 */

const WORKER_URL = process.env.WORKER_URL || process.argv[2];
if (!WORKER_URL) {
  console.error(
    "Usage: node scripts/warmup.mjs <WORKER_URL>\n" +
    "       or set the WORKER_URL environment variable."
  );
  process.exit(1);
}

/** Paths to hit — keep the worker and its D1/R2 bindings warm. */
const PATHS = [
  "/api/health",
  "/api/models",
  "/",
];

async function warmup() {
  const results = [];
  for (const path of PATHS) {
    const url = `${WORKER_URL}${path}`;
    try {
      const start = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const ms = Date.now() - start;
      results.push({ path, status: res.status, ms, ok: true });
    } catch (err) {
      results.push({ path, status: "error", ms: null, ok: false, error: err.message });
    }
  }

  // Summary
  const ok = results.filter((r) => r.ok).length;
  const total = results.length;
  const worst = results
    .filter((r) => r.ms != null)
    .reduce((max, r) => Math.max(max, r.ms), 0);

  console.log(
    `[${new Date().toISOString()}] Warmup: ${ok}/${total} OK, worst ${worst}ms`
  );
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    const detail = r.ok ? `${r.status} in ${r.ms}ms` : `${r.error}`;
    console.log(`  ${icon} ${r.path}  ${detail}`);
  }

  process.exit(ok > 0 ? 0 : 1);
}

warmup();
