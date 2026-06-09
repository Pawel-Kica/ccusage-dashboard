import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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

/** @type {Map<string, { expiresAt: number, body: object }>} */
const cache = new Map();
/** @type {Map<string, Promise<object>>} */
const inflight = new Map();

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

async function runCcusage(source, report, extraArgs = []) {
  const args = [];
  if (source !== "all") args.push(source);
  args.push(report, "--json", "--breakdown", ...extraArgs);

  const { stdout } = await execFileAsync("node", [CCUSAGE, ...args], {
    cwd: __dirname,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    env: { ...process.env, NO_COLOR: "1" },
  });

  return JSON.parse(stdout);
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
