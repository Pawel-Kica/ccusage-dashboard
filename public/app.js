const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const CACHE_TTL_MS = 5 * 60 * 1000;
const STORAGE_PREFIX = "ccusage:";
const SOURCE = "claude";
const WARMUP_REPORTS = ["daily", "weekly", "monthly"];
const WINDOW_KEY = "ccusage:window";
const WINDOW_DEFAULTS = { daily: 30, weekly: 10, monthly: 6 };
const GRANULARITY_KEY = "ccusage:granularity";
const WINDOW_OPTIONS = {
  daily: [
    { value: 7, label: "7 days" },
    { value: 14, label: "14 days" },
    { value: 21, label: "21 days" },
    { value: 30, label: "30 days" },
  ],
  weekly: [
    { value: 4, label: "4 weeks" },
    { value: 10, label: "10 weeks" },
    { value: 16, label: "16 weeks" },
    { value: 26, label: "26 weeks" },
  ],
  monthly: [
    { value: 3, label: "3 months" },
    { value: 6, label: "6 months" },
    { value: 12, label: "12 months" },
    { value: 24, label: "24 months" },
  ],
};
const CHART_BAR_HEIGHT = 180;
const GRANULARITIES = new Set(["daily", "weekly", "monthly"]);

const GRAN_META = {
  daily: { label: "Today" },
  weekly: { label: "This week" },
  monthly: { label: "This month" },
};

let granularity = readGranularity();
let lastBody = null;
const inflight = new Map();

function readWindowSizes() {
  try {
    const raw = localStorage.getItem(WINDOW_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

function writeWindowSizes(sizes) {
  try {
    localStorage.setItem(WINDOW_KEY, JSON.stringify(sizes));
  } catch {
    /* ignore */
  }
}

function getWindowSize(kind) {
  const saved = readWindowSizes()[kind];
  if (saved && WINDOW_OPTIONS[kind]?.some((o) => o.value === saved)) return saved;
  return WINDOW_DEFAULTS[kind] ?? 14;
}

function setWindowSize(kind, value) {
  const sizes = readWindowSizes();
  sizes[kind] = value;
  writeWindowSizes(sizes);
}

function windowLabelFor(kind) {
  const size = getWindowSize(kind);
  const match = WINDOW_OPTIONS[kind]?.find((o) => o.value === size);
  return match?.label ?? `${size} periods`;
}

function syncWindowSelect(kind) {
  const size = getWindowSize(kind);
  $("#window-size").innerHTML = WINDOW_OPTIONS[kind]
    .map((o) => `<option value="${o.value}"${o.value === size ? " selected" : ""}>${o.label}</option>`)
    .join("");
}

function readGranularity() {
  try {
    const v = localStorage.getItem(GRANULARITY_KEY);
    if (v && GRANULARITIES.has(v)) return v;
  } catch {
    /* ignore */
  }
  return "daily";
}

function writeGranularity(value) {
  try {
    localStorage.setItem(GRANULARITY_KEY, value);
  } catch {
    /* ignore */
  }
}

function sinceParamFor(kind) {
  const n = getWindowSize(kind);
  const d = new Date();
  if (kind === "monthly") {
    d.setMonth(d.getMonth() - n);
    d.setDate(d.getDate() - 7);
  } else if (kind === "weekly") {
    d.setDate(d.getDate() - n * 7 - 2);
  } else {
    d.setDate(d.getDate() - n - 2);
  }
  return d.toISOString().slice(0, 10);
}

function storageKey(source, reportType) {
  return `${STORAGE_PREFIX}${source}:${reportType}:${sinceParamFor(reportType)}`;
}

function readClientCache(source, reportType) {
  try {
    const raw = sessionStorage.getItem(storageKey(source, reportType));
    if (!raw) return null;
    const entry = JSON.parse(raw);
    if (Date.now() > entry.expiresAt) {
      sessionStorage.removeItem(storageKey(source, reportType));
      return null;
    }
    return entry.body;
  } catch {
    return null;
  }
}

function writeClientCache(source, reportType, body) {
  try {
    sessionStorage.setItem(
      storageKey(source, reportType),
      JSON.stringify({ expiresAt: Date.now() + CACHE_TTL_MS, body }),
    );
  } catch {
    /* quota */
  }
}

const fmtCost = (n) =>
  n == null || Number.isNaN(n)
    ? "—"
    : `$${Number(n).toLocaleString(undefined, {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;

const fmtCostAxis = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
};

const fmtTokens = (n) => {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return v.toLocaleString();
};

const shortModel = (m) =>
  m.replace("claude-", "").replace("-20251001", "").replace("gpt-", "gpt-");

function normalize(payload) {
  const data = payload.data;
  if (data.daily) return { rows: data.daily, totals: data.totals, labelKey: "date", kind: "daily" };
  if (data.weekly) return { rows: data.weekly, totals: data.totals, labelKey: "week", kind: "weekly" };
  if (data.monthly) return { rows: data.monthly, totals: data.totals, labelKey: "month", kind: "monthly" };
  return { rows: [], totals: null, labelKey: "date", kind: "daily" };
}

function rowCost(row) {
  return row.totalCost ?? row.costUSD ?? row.cost ?? 0;
}

function rowTokens(row) {
  return row.totalTokens ?? 0;
}

function totalsFrom(rows) {
  return {
    cost: rows.reduce((s, r) => s + rowCost(r), 0),
    tokens: rows.reduce((s, r) => s + rowTokens(r), 0),
  };
}

function sortRows(rows, labelKey) {
  return rows.slice().sort((a, b) => {
    const ak = String(a[labelKey] ?? "");
    const bk = String(b[labelKey] ?? "");
    return ak.localeCompare(bk);
  });
}

function windowRows(rows, labelKey, kind) {
  const sorted = sortRows(rows, labelKey);
  return sorted.slice(-getWindowSize(kind));
}

function rawPeriod(row, labelKey, kind) {
  if (kind === "daily") return row.date ?? row.period ?? row[labelKey];
  if (kind === "weekly") return row.week ?? row[labelKey] ?? row.period ?? row.date;
  if (kind === "monthly") return row.month ?? row[labelKey] ?? row.period ?? row.date;
  return row[labelKey] ?? row.period ?? row.date;
}

function parsePeriodDate(raw) {
  const s = String(raw ?? "");
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmtDayMonth(d) {
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}`;
}

function fmtDayMonthYear(d) {
  return `${fmtDayMonth(d)}.${d.getFullYear()}`;
}

function fmtDateDashWeekday(d) {
  const weekday = d.toLocaleDateString(undefined, { weekday: "long" });
  return `${fmtDayMonthYear(d)} - ${weekday}`;
}

function axisLabel(row, labelKey, kind) {
  const raw = String(rawPeriod(row, labelKey, kind) ?? "");
  if (!raw) return "—";

  if (kind === "daily") {
    const d = parsePeriodDate(raw);
    if (d) return fmtDayMonth(d);
  }
  if (kind === "weekly" && raw.length >= 8) {
    const d = new Date(raw.length === 10 ? raw : raw.slice(0, 10));
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    }
  }
  if (kind === "monthly") {
    const [y, m] = raw.split("-");
    if (y && m) {
      const d = new Date(Number(y), Number(m) - 1, 1);
      return d.toLocaleDateString(undefined, { month: "short", year: "2-digit" });
    }
  }
  return raw.length > 12 ? raw.slice(0, 10) : raw;
}

function peakLegendLabel(row, labelKey, kind) {
  const raw = rawPeriod(row, labelKey, kind);
  if (!raw) return "—";
  if (kind === "daily") {
    const d = parsePeriodDate(raw);
    if (d) {
      const wd = d.toLocaleDateString(undefined, { weekday: "short" });
      return `${fmtDayMonth(d)} · ${wd}`;
    }
  }
  return String(raw);
}

function barTooltipHtml(row, labelKey, kind, cost) {
  const raw = rawPeriod(row, labelKey, kind);
  if (kind === "daily") {
    const d = parsePeriodDate(raw);
    if (d) {
      return `${fmtDateDashWeekday(d)}<br><strong>${fmtCost(cost)}</strong><br>${fmtTokens(rowTokens(row))} tok`;
    }
  }
  const label = raw ? String(raw) : "—";
  return `${label}<br><strong>${fmtCost(cost)}</strong><br>${fmtTokens(rowTokens(row))} tok`;
}

function currentPeriodRow(rows, kind, labelKey) {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  if (kind === "daily") return rows.find((r) => r.date === today);
  if (kind === "weekly") {
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - now.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    return rows.find((r) => {
      const w = r.week ?? r.period ?? "";
      return String(w).startsWith(key) || w === key;
    });
  }
  if (kind === "monthly") {
    return rows.find((r) => {
      const m = r.month ?? r.period ?? "";
      return String(m).startsWith(month);
    });
  }
  return rows[rows.length - 1];
}

function setHeaderLoading(on) {
  $("#header-spinner").classList.toggle("hidden", !on);
  $("#refresh").disabled = on;
}

function setStatus(text, isError = false) {
  const el = $("#status");
  if (!text) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden");
  el.classList.toggle("error", isError);
}

function showSkeleton() {
  $("#cards").innerHTML = [1, 2, 3]
    .map(
      () =>
        `<div class="card skeleton"><div class="sk-line w40"></div><div class="sk-line w70 tall"></div><div class="sk-line w30"></div></div>`,
    )
    .join("");
  $("#chart").innerHTML = `<div class="chart-skeleton">${Array.from({ length: 10 }, () => `<div class="sk-bar"></div>`).join("")}</div>`;
  $("#chart-y-axis").innerHTML = "";
  $("#chart-legend").innerHTML = "";
  $("#table-body").innerHTML = Array.from(
    { length: 5 },
    () => `<tr><td colspan="8"><div class="sk-line"></div></td></tr>`,
  ).join("");
}

function renderFromBody(body) {
  lastBody = body;
  syncWindowSelect(granularity);

  const norm = normalize(body);
  const kind = norm.kind;
  const windowed = windowRows(norm.rows, norm.labelKey, kind);

  $("#chart-title").textContent = "Cost";
  $("#table-title").textContent = `Last ${windowLabelFor(granularity)}`;
  $("#table-hint").textContent = `${windowed.length} periods`;

  renderCards(windowed, norm.labelKey, kind);
  renderChart(windowed, norm.labelKey, kind);
  renderTable(windowed, norm.labelKey, kind);

  const cached = body.cached ? "cached" : "fresh";
  const expires = body.cacheExpiresAt
    ? new Date(body.cacheExpiresAt).toLocaleTimeString()
    : null;
  $("#meta").textContent = `Updated ${new Date(body.fetchedAt).toLocaleString()} · ${body.source} · ${granularity}${expires ? ` · ${cached} until ${expires}` : ""}`;
}

function renderCards(rows, labelKey, kind) {
  const { cost, tokens } = totalsFrom(rows);
  const current = currentPeriodRow(sortRows(rows, labelKey), kind, labelKey);
  const gm = GRAN_META[granularity];

  const cards = [
    {
      label: `Window total (${windowLabelFor(granularity)})`,
      value: fmtCost(cost),
      sub: `${rows.length} periods in view`,
      cls: "cost",
    },
    {
      label: "Avg per period",
      value: fmtCost(rows.length ? cost / rows.length : 0),
      sub: fmtTokens(tokens) + " tokens total",
    },
  ];

  if (current) {
    cards.push({
      label: gm.label,
      value: fmtCost(rowCost(current)),
      sub: String(current[labelKey] ?? current.date ?? "—"),
      cls: "cost",
    });
  }

  $("#cards").innerHTML = cards
    .map(
      (c) => `
    <div class="card">
      <div class="card-label">${c.label}</div>
      <div class="card-value ${c.cls || ""}">${c.value}</div>
      <div class="card-sub">${c.sub}</div>
    </div>`,
    )
    .join("");
}

function renderChart(rows, labelKey, kind) {
  const panel = $("#chart-panel");
  if (!rows.length) {
    panel.classList.add("hidden");
    return;
  }
  panel.classList.remove("hidden");

  const costs = rows.map(rowCost);
  const max = Math.max(...costs, 0.01);
  const total = costs.reduce((a, b) => a + b, 0);
  const peakRow = rows[costs.indexOf(max)];

  const yTicks = [max, max / 2, 0];
  $("#chart-y-axis").innerHTML = yTicks
    .map((v) => `<span>${fmtCostAxis(v)}</span>`)
    .join("");

  $("#chart-legend").innerHTML = `
    <div class="legend-stat"><span class="legend-k">Total</span><span class="legend-v cost">${fmtCost(total)}</span></div>
    <div class="legend-stat"><span class="legend-k">Average</span><span class="legend-v">${fmtCost(total / rows.length)}</span></div>
    <div class="legend-stat"><span class="legend-k">Peak</span><span class="legend-v">${fmtCost(max)} <span class="legend-dim">· ${peakLegendLabel(peakRow, labelKey, kind)}</span></span></div>
    <div class="legend-stat legend-hint">Hover bars for details</div>`;

  const barTips = rows.map((row) => barTooltipHtml(row, labelKey, kind, rowCost(row)));

  const bars = rows
    .map((row, i) => {
      const cost = rowCost(row);
      const barPx = Math.max(4, Math.round((cost / max) * CHART_BAR_HEIGHT));
      return `
        <div class="bar-col" tabindex="0" data-bar-idx="${i}">
          <div class="bar-track">
            <div class="bar-fill" style="height: ${barPx}px"></div>
          </div>
        </div>`;
    })
    .join("");

  const labels = rows
    .map((row) => `<div class="xlabel">${axisLabel(row, labelKey, kind)}</div>`)
    .join("");

  const scrollClass =
    kind === "daily" ? "chart-fit" : rows.length >= 10 ? "chart-dense" : "";
  $("#chart").innerHTML = `
    <div class="chart-scroll${scrollClass ? ` ${scrollClass}` : ""}">
      <div class="chart-bars">${bars}</div>
      <div class="chart-xlabels">${labels}</div>
    </div>`;

  bindChartBars(barTips);
}

function positionChartTooltip(col) {
  const tip = $("#chart-float-tooltip");
  const rect = col.getBoundingClientRect();
  tip.style.left = `${rect.left + rect.width / 2}px`;
  tip.style.top = `${rect.top}px`;
}

function showChartTooltip(html) {
  const tip = $("#chart-float-tooltip");
  tip.innerHTML = html;
  tip.classList.remove("hidden");
}

function hideChartTooltip() {
  $("#chart-float-tooltip").classList.add("hidden");
}

function bindChartBars(tips) {
  $("#chart").querySelectorAll(".bar-col").forEach((col) => {
    const idx = Number(col.dataset.barIdx);
    const html = tips[idx];
    if (!html) return;

    col.addEventListener("pointerenter", () => {
      showChartTooltip(html);
      positionChartTooltip(col);
    });
    col.addEventListener("pointerleave", hideChartTooltip);
    col.addEventListener("focus", () => {
      showChartTooltip(html);
      positionChartTooltip(col);
    });
    col.addEventListener("blur", hideChartTooltip);
  });
}

function modelChips(models) {
  if (!models?.length) return '<span class="text-dim">—</span>';
  const shown = models.slice(0, 4);
  const more = models.length - shown.length;
  return `<div class="models">${shown
    .map((m) => `<span class="chip">${shortModel(m)}</span>`)
    .join("")}${more > 0 ? `<span class="chip muted">+${more}</span>` : ""}</div>`;
}

function periodCell(row, labelKey, kind) {
  if (kind === "daily") return row.date ?? row[labelKey] ?? "—";
  if (kind === "weekly") return row.week ?? row[labelKey] ?? row.period ?? "—";
  if (kind === "monthly") return row.month ?? row[labelKey] ?? row.period ?? "—";
  return row[labelKey] ?? "—";
}

function breakdownBadgeHtml(count) {
  if (!count) return "";
  return `
    <span class="breakdown-badge" aria-hidden="true">
      <svg class="breakdown-chevron" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
        <path d="M3 4.5 L6 7.5 L9 4.5" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      ${count} model${count > 1 ? "s" : ""}
    </span>`;
}

function breakdownTableHtml(breakdowns) {
  if (!breakdowns?.length) return "";
  return `
    <table class="breakdown-table">
      <thead>
        <tr>
          <th>Model</th>
          <th>In</th>
          <th>Out</th>
          <th>Cache W</th>
          <th>Cache R</th>
          <th>Cost</th>
        </tr>
      </thead>
      <tbody>
        ${breakdowns
          .map(
            (m) => `
          <tr>
            <td>${shortModel(m.modelName)}</td>
            <td class="num">${fmtTokens(m.inputTokens)}</td>
            <td class="num">${fmtTokens(m.outputTokens)}</td>
            <td class="num">${fmtTokens(m.cacheCreationTokens)}</td>
            <td class="num">${fmtTokens(m.cacheReadTokens)}</td>
            <td class="cost">${fmtCost(m.cost)}</td>
          </tr>`,
          )
          .join("")}
      </tbody>
    </table>`;
}

function renderTable(rows, labelKey, kind) {
  $("#table-head").innerHTML = `
    <tr>
      <th>Period</th>
      <th>Models</th>
      <th>Input</th>
      <th>Output</th>
      <th>Cache W</th>
      <th>Cache R</th>
      <th>Total</th>
      <th>Cost</th>
    </tr>`;

  $("#table-body").innerHTML = rows.length
    ? rows
        .slice()
        .reverse()
        .map(
          (row) => {
            const expandable = row.modelBreakdowns?.length > 0;
            return `
      <tr class="period-row${expandable ? " expandable" : ""}"${expandable ? " tabindex=\"0\" role=\"button\" aria-expanded=\"false\"" : ""}>
        <td class="mono">${expandable ? '<input type="checkbox" class="breakdown-cb" hidden tabindex="-1">' : ""}${periodCell(row, labelKey, kind)}</td>
        <td class="models-cell">
          <div class="models-inline">
            ${modelChips(row.modelsUsed)}
            ${breakdownBadgeHtml(row.modelBreakdowns?.length)}
          </div>
        </td>
        <td class="num">${fmtTokens(row.inputTokens)}</td>
        <td class="num">${fmtTokens(row.outputTokens)}</td>
        <td class="num">${fmtTokens(row.cacheCreationTokens)}</td>
        <td class="num">${fmtTokens(row.cacheReadTokens)}</td>
        <td class="num">${fmtTokens(row.totalTokens)}</td>
        <td class="cost">${fmtCost(rowCost(row))}</td>
      </tr>
      ${expandable ? `<tr class="subrow"><td colspan="8">${breakdownTableHtml(row.modelBreakdowns)}</td></tr>` : ""}`;
          },
        )
        .join("")
    : `<tr><td colspan="8" class="empty">No data for this range</td></tr>`;
}

async function fetchUsage(source, reportType, force) {
  const since = sinceParamFor(reportType);
  const key = `${source}:${reportType}:${since}`;
  if (!force && inflight.has(key)) return inflight.get(key);

  const params = new URLSearchParams({ report: reportType, source, since });
  if (force) params.set("refresh", "1");

  const promise = fetch(`/api/usage?${params}`)
    .then(async (res) => {
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || body.detail || "Request failed");
      writeClientCache(source, reportType, body);
      return body;
    })
    .finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}

async function load({ force = false } = {}) {
  const source = SOURCE;
  const activeGran = granularity;
  const cached = !force && readClientCache(source, granularity);

  setStatus("");
  if (cached) {
    renderFromBody(cached);
  } else {
    showSkeleton();
  }

  setHeaderLoading(true);
  try {
    const body = await fetchUsage(source, granularity, force);
    if (granularity === activeGran) {
      renderFromBody(body);
    }
  } catch (err) {
    if (granularity === activeGran && !cached) setStatus(err.message, true);
  } finally {
    setHeaderLoading(false);
  }
}

async function warmup(source) {
  try {
    await fetch(`/api/warmup?source=${encodeURIComponent(source)}`);
    for (const r of WARMUP_REPORTS) {
      if (r === granularity) continue;
      await fetchUsage(source, r, false);
    }
  } catch {
    /* background */
  }
}

$$("#granularity .gran").forEach((btn) => {
  if (btn.dataset.granularity === granularity) btn.classList.add("active");
  else btn.classList.remove("active");
  btn.addEventListener("click", () => {
    $$("#granularity .gran").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    granularity = btn.dataset.granularity;
    writeGranularity(granularity);
    load();
  });
});

$("#refresh").addEventListener("click", () => load({ force: true }));

$("#window-size").addEventListener("change", () => {
  setWindowSize(granularity, Number($("#window-size").value));
  load();
});

syncWindowSelect(granularity);

function toggleExpandableRow(row) {
  const cb = row.querySelector(".breakdown-cb");
  if (!cb) return;
  cb.checked = !cb.checked;
  row.setAttribute("aria-expanded", cb.checked);
}

$("#table-body").addEventListener("click", (e) => {
  const row = e.target.closest("tr.period-row.expandable");
  if (!row) return;
  toggleExpandableRow(row);
});

$("#table-body").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const row = e.target.closest("tr.period-row.expandable");
  if (!row) return;
  e.preventDefault();
  toggleExpandableRow(row);
});

load().then(() => warmup(SOURCE));
