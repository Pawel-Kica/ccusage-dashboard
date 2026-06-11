import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3847;
const OPEN = process.argv.includes("--open");

const CCUSAGE = join(__dirname, "node_modules", "ccusage", "dist", "cli.js");
const REPORTS = new Set(["daily", "weekly", "monthly"]);
const SOURCE = "claude";
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS) || 5 * 60 * 1000;
const PLAN_CACHE_TTL_MS = Number(process.env.PLAN_CACHE_TTL_MS) || 2 * 60 * 1000;
const CREDENTIALS_PATH = join(homedir(), ".claude", ".credentials.json");
const USAGE_API = "https://api.anthropic.com/api/oauth/usage";

/** @type {Map<string, { expiresAt: number, body: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

/** @type {{ expiresAt: number, body: object } | null} */
let planCache = null;
/** @type {Promise<object> | null} */
let planInflight = null;

function cacheKey(source, report, since, until) {
  return `${source}:${report}:${since ?? ""}:${until ?? ""}`;
}

async function getUsage(source, report, since, until, forceRefresh) {
  const key = cacheKey(source, report, since, until);
  const now = Date.now();

  if (!forceRefresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now) return { ...hit.body, cached: true };
  }

  if (!forceRefresh && inflight.has(key)) {
    return inflight.get(key);
  }

  const extra = [];
  if (since) extra.push("--since", since);
  if (until) extra.push("--until", until);

  const promise = (async () => {
    const fetchedAt = new Date().toISOString();
    const data = await runCcusage(source, report, extra);
    const body = {
      report,
      source,
      data,
      fetchedAt,
      cached: false,
      cacheExpiresAt: new Date(now + CACHE_TTL_MS).toISOString(),
    };
    cache.set(key, { expiresAt: now + CACHE_TTL_MS, body });
    return body;
  })();

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}

async function runCcusage(source, report, extraArgs = [], { breakdown = true } = {}) {
  const args = [];
  if (source !== "all") args.push(source);
  args.push(report, "--json");
  if (breakdown) args.push("--breakdown");
  args.push(...extraArgs);

  const { stdout } = await execFileAsync("node", [CCUSAGE, ...args], {
    cwd: __dirname,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  return JSON.parse(stdout);
}

async function readCredentials() {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync(
        "security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 10000 },
      );
      return JSON.parse(stdout.trim());
    } catch {
      /* fall through to file */
    }
  }

  const raw = await readFile(CREDENTIALS_PATH, "utf8");
  return JSON.parse(raw);
}

async function fetchOAuthUsage(token) {
  const res = await fetch(USAGE_API, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "claude-code/2.0.32",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Usage API ${res.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
  }

  return res.json();
}

async function getActiveSessionBlock() {
  const data = await runCcusage(SOURCE, "blocks", [], { breakdown: false });
  const blocks = (data.blocks ?? []).filter((b) => !b.isGap);
  const active = blocks.find((b) => b.isActive);
  return active ?? blocks[blocks.length - 1] ?? null;
}

async function getPlan(forceRefresh) {
  const now = Date.now();

  if (!forceRefresh && planCache && planCache.expiresAt > now) {
    return { ...planCache.body, cached: true };
  }

  if (!forceRefresh && planInflight) return planInflight;

  const promise = (async () => {
    const fetchedAt = new Date().toISOString();
    const creds = await readCredentials();
    const oauth = creds.claudeAiOauth ?? {};
    const plan = {
      subscriptionType: oauth.subscriptionType ?? null,
      rateLimitTier: oauth.rateLimitTier ?? null,
    };

    let limits = null;
    let limitsError = null;
    const token = oauth.accessToken;
    if (token) {
      try {
        limits = await fetchOAuthUsage(token);
      } catch (err) {
        limitsError = err.message || "Failed to fetch plan limits";
      }
    } else {
      limitsError = "No OAuth token in credentials";
    }

    let session = null;
    let sessionError = null;
    try {
      const block = await getActiveSessionBlock();
      if (block) {
        session = {
          costUSD: block.costUSD ?? 0,
          startTime: block.startTime,
          endTime: block.endTime,
          isActive: Boolean(block.isActive),
          totalTokens: block.totalTokens ?? 0,
        };
      }
    } catch (err) {
      sessionError = err.message || "Failed to read session block";
    }

    const body = {
      plan,
      limits,
      limitsError,
      session,
      sessionError,
      fetchedAt,
      cached: false,
      cacheExpiresAt: new Date(now + PLAN_CACHE_TTL_MS).toISOString(),
    };

    planCache = { expiresAt: now + PLAN_CACHE_TTL_MS, body };
    return body;
  })();

  planInflight = promise;
  try {
    return await promise;
  } finally {
    planInflight = null;
  }
}

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function serveStatic(res, path) {
  const file = join(PUBLIC, path === "/" ? "index.html" : path);
  try {
    const data = await readFile(file);
    const type =
      path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".js")
          ? "application/javascript"
          : "text/html";
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/api/usage") {
      const report = url.searchParams.get("report") || "daily";
      const since = url.searchParams.get("since");
      const until = url.searchParams.get("until");

      if (!REPORTS.has(report)) {
        json(res, 400, { error: `Unknown report: ${report}` });
        return;
      }

      const forceRefresh = url.searchParams.get("refresh") === "1";
      const body = await getUsage(SOURCE, report, since, until, forceRefresh);
      json(res, 200, body);
      return;
    }

    if (url.pathname === "/api/warmup") {
      const reports = [...REPORTS];
      await Promise.all(
        reports.map((report) => getUsage(SOURCE, report, null, null, false)),
      );
      json(res, 200, { ok: true, source: SOURCE, reports, warmedAt: new Date().toISOString() });
      return;
    }

    if (url.pathname === "/api/plan") {
      const forceRefresh = url.searchParams.get("refresh") === "1";
      const body = await getPlan(forceRefresh);
      json(res, 200, body);
      return;
    }

    if (url.pathname === "/api/health") {
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      json(res, 404, { error: "Not found" });
      return;
    }

    const staticPath = url.pathname === "/" ? "/" : url.pathname.slice(1);
    if (staticPath.includes("..")) {
      json(res, 403, { error: "Forbidden" });
      return;
    }
    await serveStatic(res, staticPath === "" ? "/" : staticPath);
  } catch (err) {
    console.error(err);
    json(res, 500, {
      error: err.message || "Internal error",
      detail: err.stderr?.toString?.() || undefined,
    });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`CC Usage dashboard → ${url}`);
  if (OPEN) {
    import("node:child_process").then(({ exec }) =>
      exec(`open "${url}"`),
    );
  }
});
