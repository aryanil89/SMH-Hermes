/*
 * Wall renderer.
 *
 * One SSE stream in, one full DashboardSnapshot per tick. Rendering is a keyed
 * diff rather than innerHTML: at a 2s cadence a wholesale rewrite would reset
 * scroll position in the two log panes, restart every enter animation, and drop
 * a tooltip the moment anyone hovered a chart.
 */

const MAX_TABLE_ROWS = 60;
/** How long an inbound Telegram message keeps the upstream rail animating. */
const INBOUND_GLOW_MS = 30_000;

const $ = (id) => document.getElementById(id);

const els = {
  brandSub: $("brand-sub"),
  headTick: $("head-tick"),
  headBuild: $("head-build"),
  headUptime: $("head-uptime"),
  headClock: $("head-clock"),
  overallPill: $("overall-pill"),
  conn: $("conn"),
  connLabel: $("conn-label"),

  deviceSub: $("device-sub"),
  deviceSource: $("device-source"),
  deviceTransport: $("device-transport"),
  deviceAge: $("device-age"),
  deviceFallback: $("device-fallback"),
  deviceEvents: $("device-events"),
  accessCard: $("access-card"),
  accessChip: $("access-chip"),
  accessVerdict: $("access-verdict"),
  accessWelcome: $("access-welcome"),
  accessIdentity: $("access-identity"),
  accessFaces: $("access-faces"),
  accessReasons: $("access-reasons"),
  accessApprovalPanel: $("access-approval-panel"),
  accessApprovalHeadline: $("access-approval-headline"),
  accessApprovalPhoto: $("access-approval-photo"),
  accessApprovalMeta: $("access-approval-meta"),
  accessApproveBtn: $("access-approve-btn"),
  accessDenyBtn: $("access-deny-btn"),
  accessApprovalResult: $("access-approval-result"),
  accessLog: $("access-log"),
  deviceLogCount: $("device-log-count"),
  tempCard: $("temp-card"),
  tempValue: $("temp-value"),
  tempChip: $("temp-chip"),
  tempSpark: $("temp-spark"),
  tempNote: $("temp-note"),
  humCard: $("hum-card"),
  humValue: $("hum-value"),
  humChip: $("hum-chip"),
  humSpark: $("hum-spark"),
  humNote: $("hum-note"),
  climateTable: $("climate-table"),

  conduitIn: $("conduit-in"),
  conduitInFoot: $("conduit-in-foot"),
  conduitOut: $("conduit-out"),
  conduitOutFoot: $("conduit-out-foot"),

  serverTitle: $("server-title"),
  serverSub: $("server-sub"),
  feedChip: $("feed-chip"),
  feedKv: $("feed-kv"),
  feedReason: $("feed-reason"),
  confidenceChip: $("confidence-chip"),
  riskScore: $("risk-score"),
  riskLevel: $("risk-level"),
  riskMeter: $("risk-meter"),
  riskMeterWrap: $("risk-meter-wrap"),
  riskFamilies: $("risk-families"),
  likelyCause: $("likely-cause"),
  recommended: $("recommended"),
  evidence: $("evidence"),
  evidenceCount: $("evidence-count"),
  provenance: $("provenance"),
  families: $("families"),
  feeders: $("feeders"),
  sourcesCount: $("sources-count"),
  pipeline: $("pipeline"),

  tgBot: $("tg-bot"),
  tgSub: $("tg-sub"),
  tgThread: $("tg-thread"),
  watchdogChip: $("watchdog-chip"),
  watchdogKv: $("watchdog-kv"),
  watchdogNote: $("watchdog-note"),

  tooltip: $("tooltip"),

  // Live system summary tab -- a sparser, projector-scale mirror of a subset
  // of the fields above. Kept as distinct elements (not shared ids) because
  // getElementById only ever resolves to the first match in the document;
  // see setTile(), renderServer() and renderAccess() for how each pair stays
  // in sync.
  sumRiskScore: $("sum-risk-score"),
  sumRiskLevel: $("sum-risk-level"),
  sumRiskMeter: $("sum-risk-meter"),
  sumRiskMeterWrap: $("sum-risk-meter-wrap"),
  sumLikelyCause: $("sum-likely-cause"),
  sumRecommended: $("sum-recommended"),
  sumTempCard: $("sum-temp-card"),
  sumTempValue: $("sum-temp-value"),
  sumTempChip: $("sum-temp-chip"),
  sumHumCard: $("sum-hum-card"),
  sumHumValue: $("sum-hum-value"),
  sumHumChip: $("sum-hum-chip"),
  sumAccessCard: $("sum-access-card"),
  sumAccessChip: $("sum-access-chip"),
  sumAccessVerdict: $("sum-access-verdict"),
  sumFamilies: $("sum-families"),
  sumInfraCount: $("sum-infra-count"),
  sumTgBot: $("sum-tg-bot"),
  sumTgSub: $("sum-tg-sub"),
  sumTgThread: $("sum-tg-thread"),

  demoToggle: $("demo-toggle"),
  demoToggleLabel: $("demo-toggle-label"),
  demoBadge: $("demo-badge"),
};

/** The board's raw event vocabulary, in words anyone can read off the wall. */
const EVENT_LABELS = {
  sensor_tick: "climate tick",
  door_open: "door opened",
  door_closed: "door closed",
  light_on: "lighting on",
  light_off: "lighting off",
  leak_detected: "leak detected",
  leak_cleared: "leak cleared",
  object_entered: "presence detected",
  object_left: "presence cleared",
};

const EVENT_STATUS = {
  leak_detected: "critical",
  door_open: "warning",
};

/**
 * `event: "activity"` lines (docs/ONDEVICE_ACTIVITY.md) carry their own label
 * in `event.activity`, not a fixed string from EVENT_LABELS above -- this
 * turns `activity-person_entered_room` into "Person entered room". Mirrors
 * `humanizeActivity` in `src/common/activity.ts`; kept as a small
 * frontend-local copy the same way EVENT_LABELS already duplicates
 * DEVICE_EVENT_LABELS server-side, rather than round-tripping through an API
 * call just to format a string.
 */
function humanizeActivity(activity) {
  const words = activity.replace(/^activity-/, "").split("_").filter(Boolean);
  if (words.length === 0) return activity;
  return words.map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
}

function activityStatus(activity) {
  const lower = activity.toLowerCase();
  if (lower.includes("fire") || lower.includes("leak")) return "critical";
  if (lower.includes("risk")) return "warning";
  return "ok";
}

/** Pipeline "src" tag text -- see PipelineEvent.source in src/dashboard/types.ts
 * for why "inference" (laptop) and "board-inference" (UNO Q) are kept separate. */
const PIPELINE_SOURCE_LABELS = { physical: "sensor", "board-inference": "board AI" };

const RISK_STATUS = { low: "ok", medium: "warning", high: "serious", critical: "critical" };
const STATUS_ICON = { ok: "#i-check", warning: "#i-warn", critical: "#i-crit", unknown: "#i-unknown" };

let latest = null;
let lastInboundAt = 0;
/**
 * True while the Live system summary is showing the scripted demo loop
 * instead of the real feed. Every "sum" write site (setTile, renderServer,
 * renderAccess, renderPhone) checks this and skips its own write when it's
 * true, so the demo engine has sole ownership of those elements and Live
 * details -- which never checks this flag -- always shows the real feed.
 */
let demoMode = false;

/**
 * Whether the newest phone message is actually on screen right now.
 *
 * Not derived from `els.tgThread`'s own scrollTop/scrollHeight: above 940px
 * wide the phone panel scrolls internally (styles.css `.tg-thread{overflow-y:
 * auto}`), but the `@media (max-width: 940px)` fallback sets `.column{overflow:
 * visible}` and lets the whole page scroll instead -- at that width `tg-thread`
 * never has its own overflow, so its scrollHeight always equals its
 * clientHeight and a scrollTop assignment aimed at it is a silent no-op. The
 * newest message keeps landing off-screen with nothing to bring it back.
 *
 * An IntersectionObserver on a zero-height anchor pinned to the end of the
 * thread sidesteps the question of which ancestor is actually scrolling: it
 * reports whether the anchor is visible through every clipping/scrolling
 * ancestor between it and the viewport, root:null and all.
 */
let phoneAtBottom = true;
/**
 * Breaks a real deadlock, not a hypothetical one (reproduced live): the phone
 * panel lives on the "Live details" tab, and a `display:none` tab's contents
 * report scrollHeight/clientHeight/scrollTop as 0 no matter how much text is
 * in them. A tick that lands while the tab is still hidden can render the
 * entire backlog into a 0-sized box, so the scroll-to-bottom it attempts is a
 * no-op -- and once the tab becomes visible on a later tick, scrollTop is
 * stuck at 0 against a now-real scrollHeight, which the observer correctly
 * reads as "scrolled away" forever, because nothing has moved it since.
 * `phoneAtBottom` alone can never recover from that: it only ever reports
 * what IS visible, never forces anything into view. The first tick that
 * measures the panel with real geometry gets one unconditional scroll so
 * there is always at least one attempt made while it can actually land.
 */
let phoneEverVisible = false;
const tgAnchor = document.createElement("li");
tgAnchor.className = "tg-anchor";
tgAnchor.setAttribute("aria-hidden", "true");
els.tgThread.append(tgAnchor);
new IntersectionObserver(([entry]) => { phoneAtBottom = entry.isIntersecting; }, {
  threshold: 0,
}).observe(tgAnchor);

/* ── formatting ──────────────────────────────────────────────────────────── */

function clock(iso) {
  if (!iso) return "–";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "–"
    : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function age(seconds) {
  if (seconds === undefined || seconds === null || Number.isNaN(seconds)) return "–";
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function bytes(n) {
  if (!n) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function setText(node, text) {
  const value = text === undefined || text === null || text === "" ? "–" : String(text);
  if (node.textContent !== value) node.textContent = value;
}

function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/* ── keyed list diff ─────────────────────────────────────────────────────── */

function renderList(container, items, keyOf, create, update) {
  const existing = new Map();
  for (const node of Array.from(container.children)) {
    // Unkeyed children are not ours -- the chat thread's empty-state placeholder
    // lives in the same <ol>. Tracking them would make every tick delete and
    // recreate the placeholder, and it would fight the insert positions below.
    if (node.dataset.key === undefined) continue;
    existing.set(node.dataset.key, node);
  }

  let index = 0;
  for (const item of items) {
    const key = String(keyOf(item));
    let node = existing.get(key);
    if (node) {
      existing.delete(key);
      if (update) update(node, item);
    } else {
      node = create(item);
      node.dataset.key = key;
      if (update) update(node, item);
      // After update(): an update that rewrites className would otherwise drop
      // the animation class the moment the node was born.
      node.classList.add("enter");
      node.addEventListener("animationend", () => node.classList.remove("enter"), { once: true });
    }
    const current = container.children[index];
    if (current !== node) container.insertBefore(node, current ?? null);
    index += 1;
  }
  for (const stale of existing.values()) stale.remove();
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
}

/**
 * A definition list is a flat dt/dd sequence, so it has no per-row node to key a
 * diff on. These lists are short, never scrolled and never animated, so a
 * signature-gated rewrite is both simpler and cheaper than faking a row wrapper.
 */
function kvRows(dl, rows) {
  const signature = rows.map((row) => `${row.label}=${row.value}=${row.status ?? ""}`).join("|");
  if (dl.dataset.sig === signature) return;
  dl.dataset.sig = signature;
  dl.innerHTML = rows
    .map((row) => {
      const status = row.status ? ` data-status="${escapeHtml(row.status)}"` : "";
      const title = ` title="${escapeHtml(row.title ?? row.value)}"`;
      return `<dt>${escapeHtml(row.label)}</dt><dd${status}${title}>${escapeHtml(row.value)}</dd>`;
    })
    .join("");
}

/* ── sparkline ───────────────────────────────────────────────────────────── */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

/**
 * One series, one hue, no axis furniture beyond a threshold reference.
 *
 * The threshold hairline is drawn only when it falls inside the data's own
 * range. Forcing a 30 C warning line into a view of 23 C readings would flatten
 * the trend into a straight line at the bottom of the box and hide the very
 * movement the panel exists to show; the caption carries it instead.
 */
function drawSpark(fig, points, opts) {
  const width = Math.max(120, Math.floor(fig.clientWidth || 260));
  const height = 58;
  const signature = `${points.length}|${points[points.length - 1]?.at ?? ""}|${width}|${opts.threshold}`;
  if (fig.dataset.sig === signature) return;
  fig.dataset.sig = signature;
  fig.textContent = "";

  if (points.length < 2) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "waiting for readings…";
    fig.append(empty);
    return;
  }

  const padX = 7;
  const padY = 8;
  const values = points.map((p) => p.value);
  let min = Math.min(...values);
  let max = Math.max(...values);
  const span = max - min;
  const pad = span < 0.4 ? 0.5 : span * 0.12;
  min -= pad;
  max += pad;

  const x = (i) => padX + (i * (width - padX * 2)) / (points.length - 1);
  const y = (v) => height - padY - ((v - min) / (max - min)) * (height - padY * 2);

  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const areaPath = `${line} L${x(points.length - 1).toFixed(1)},${height} L${x(0).toFixed(1)},${height} Z`;

  const svg = svgEl("svg", { viewBox: `0 0 ${width} ${height}`, width, height, role: "img" });
  svg.setAttribute("aria-label", `${opts.label} trend, ${points.length} readings`);

  if (opts.threshold > min && opts.threshold < max) {
    svg.append(
      svgEl("path", {
        class: "spark-threshold",
        d: `M${padX},${y(opts.threshold).toFixed(1)} L${(width - padX).toFixed(1)},${y(opts.threshold).toFixed(1)}`,
      }),
    );
  }

  // Colours go through inline style, not presentation attributes: `var()` is a
  // CSS value and is not resolved when it appears in `fill="…"` markup.
  const area = svgEl("path", { class: "spark-area", d: areaPath });
  area.style.fill = opts.color;
  const stroke = svgEl("path", { class: "spark-line", d: line });
  stroke.style.stroke = opts.color;
  svg.append(area, stroke);

  const lastIndex = points.length - 1;
  const endDot = svgEl("circle", {
    class: "spark-end",
    cx: x(lastIndex).toFixed(1),
    cy: y(points[lastIndex].value).toFixed(1),
    r: 4,
  });
  endDot.style.fill = opts.color;
  svg.append(endDot);

  const crosshair = svgEl("path", { class: "spark-crosshair", d: "", opacity: 0 });
  const marker = svgEl("circle", { class: "spark-end", cx: 0, cy: 0, r: 4.5, opacity: 0 });
  marker.style.fill = opts.color;
  svg.append(crosshair, marker);

  // A full-box hit area: a 2px line is an unfair target, and the nearest-point
  // lookup makes anywhere in the column count as a hit.
  const hit = svgEl("rect", { class: "spark-hit", x: 0, y: 0, width, height });
  svg.append(hit);

  const showAt = (clientX, clientY) => {
    const box = svg.getBoundingClientRect();
    const localX = clientX - box.left;
    const ratio = (localX - padX) / (width - padX * 2);
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const point = points[index];
    crosshair.setAttribute("d", `M${x(index).toFixed(1)},${padY - 4} L${x(index).toFixed(1)},${height - padY + 4}`);
    crosshair.setAttribute("opacity", "1");
    marker.setAttribute("cx", x(index).toFixed(1));
    marker.setAttribute("cy", y(point.value).toFixed(1));
    marker.setAttribute("opacity", "1");
    els.tooltip.hidden = false;
    els.tooltip.innerHTML = `<span class="tip-label">${clock(point.at)}</span><br>${point.value.toFixed(2)}${opts.unit}`;
    const tipBox = els.tooltip.getBoundingClientRect();
    const left = Math.min(window.innerWidth - tipBox.width - 8, Math.max(8, clientX - tipBox.width / 2));
    els.tooltip.style.left = `${left}px`;
    els.tooltip.style.top = `${Math.max(8, clientY - tipBox.height - 12)}px`;
  };

  const hide = () => {
    crosshair.setAttribute("opacity", "0");
    marker.setAttribute("opacity", "0");
    els.tooltip.hidden = true;
  };

  svg.addEventListener("pointermove", (event) => showAt(event.clientX, event.clientY));
  svg.addEventListener("pointerleave", hide);
  fig.append(svg);
}

/* ── render: header ──────────────────────────────────────────────────────── */

function renderHeader(snap) {
  // A dead sensor feed outranks the family rollup: every environmental number
  // downstream of it is mock, so a green "all clear" would be the single most
  // misleading thing this page could show.
  const feedDown = !snap.feed.connected;
  const worst = feedDown ? "critical" : worstOf([snap.device.status, ...snap.server.families.map((f) => f.status)]);
  setAttr(els.overallPill, "data-status", worst);
  els.overallPill.querySelector("use").setAttribute("href", STATUS_ICON[worst] ?? STATUS_ICON.unknown);
  setText(
    els.overallPill.querySelector("span"),
    feedDown
      ? "Sensor feed down · environmental reading is mock"
      : worst === "ok"
        ? "All families within thresholds"
        : `${worst.toUpperCase()} · see assessment`,
  );

  setText(els.brandSub, `${snap.server.model} · ${snap.server.accelerator}`);
  setText(els.headTick, `#${snap.server.tick}`);
  setText(els.headBuild, `${snap.server.buildMs} ms`);
  setText(els.headUptime, age(snap.server.uptimeSeconds));
  setText(els.headClock, clock(snap.generatedAt));
}

function worstOf(statuses) {
  if (statuses.includes("critical")) return "critical";
  if (statuses.includes("warning")) return "warning";
  return statuses.length ? "ok" : "unknown";
}

/* ── render: device column ───────────────────────────────────────────────── */

function channelStatus(channel, activeIsWarning) {
  if (!channel.observed) return "unknown";
  const active = channel.state === "open" || channel.state === "on" || channel.state === "present";
  if (active && activeIsWarning) return "warning";
  return "ok";
}

function heldText(channel) {
  if (!channel.observed) return "no edge in log window";
  return channel.heldSeconds === undefined ? "since unknown" : `for ${age(channel.heldSeconds)}`;
}

function renderDevice(snap) {
  const d = snap.device;
  setText(els.deviceSub, `${d.name} · ${d.zone}`);

  setText(els.deviceSource, d.source === "real" ? "source · real sensor" : "source · mock");
  els.deviceSource.dataset.tone = d.source;
  setText(els.deviceTransport, `transport · ${d.via ?? "none"}`);
  setText(els.deviceAge, `reading age · ${age(d.ageSeconds)}`);

  els.deviceFallback.hidden = !d.fallbackReason;
  if (d.fallbackReason) setText(els.deviceFallback, `Mock fallback: ${d.fallbackReason}`);

  setTile("door", d.door.state, heldText(d.door), channelStatus(d.door, true));
  setTile("light", d.light.state, heldText(d.light), channelStatus(d.light, false));
  setTile(
    "leak",
    d.leakDetected ? "leak" : "dry",
    d.leakDetected ? `via ${d.leakVia ?? "event"}` : "no leak in window",
    d.leakStatus,
  );
  // The board reports distance only on presence and button lines, and only
  // inside its presence gate — so a missing value means "nothing in range",
  // which is different from a broken sensor and has to read that way.
  const tof =
    d.distanceMm === undefined
      ? `nothing within ${d.presenceThresholdMm} mm`
      : d.distanceAgeSeconds === undefined
        ? `ToF ${Math.round(d.distanceMm)} mm`
        : `ToF ${Math.round(d.distanceMm)} mm · ${age(d.distanceAgeSeconds)} ago`;
  setTile("presence", d.presence.state, tof, channelStatus(d.presence, false));

  setText(els.tempValue, d.temperatureC.toFixed(1));
  setAttr(els.tempChip, "data-status", d.temperatureStatus);
  setText(els.tempChip, d.temperatureStatus);
  setAttr(els.tempCard, "data-status", d.temperatureStatus);
  setText(els.humValue, d.humidityPct.toFixed(1));
  setAttr(els.humChip, "data-status", d.humidityStatus);
  setText(els.humChip, d.humidityStatus);
  setAttr(els.humCard, "data-status", d.humidityStatus);

  if (!demoMode) writeSummaryTemp(d.temperatureC, d.temperatureStatus, d.humidityPct, d.humidityStatus);

  drawSpark(
    els.tempSpark,
    d.climate.map((p) => ({ at: p.at, value: p.temperatureC })),
    { color: "var(--series-temp)", threshold: d.thresholds.temperatureC.warning, unit: " °C", label: "Temperature" },
  );
  drawSpark(
    els.humSpark,
    d.climate.map((p) => ({ at: p.at, value: p.humidityPct })),
    { color: "var(--series-hum)", threshold: d.thresholds.humidityPct.warning, unit: "% RH", label: "Humidity" },
  );

  // The trend always comes from the log; the big number comes from the
  // environmental tool, which substitutes mock data when the log is unusable.
  // When those two sources diverge the page has to say so, or the wall shows a
  // mock 20.7 °C sitting on top of a real 22.8 °C trace and reads as a glitch.
  const trendIsLive = d.source === "real";
  els.tempSpark.dataset.stale = String(!trendIsLive);
  els.humSpark.dataset.stale = String(!trendIsLive);

  const span = d.climate.length
    ? trendIsLive
      ? `${clock(d.climate[0].at)} → ${clock(d.climate[d.climate.length - 1].at)}`
      : `last logged trend · ${age(snap.feed.ageSeconds)} old`
    : "no readings";
  const caveat = trendIsLive ? "" : " · value above is mock";
  els.tempNote.innerHTML = `<span>${span}</span><span>warning at ${d.thresholds.temperatureC.warning} °C${caveat}</span>`;
  els.humNote.innerHTML = `<span>${d.climate.length} readings</span><span>warning at ${d.thresholds.humidityPct.warning}%${caveat}</span>`;

  renderClimateTable(d.climate);

  const tickCount = d.events.length;
  setText(els.deviceLogCount, `${tickCount} lines · ${snap.feed.linesIngested} since start`);
  renderList(
    els.deviceEvents,
    d.events,
    (event) => event.id,
    (event) => {
      const li = document.createElement("li");
      const isActivity = event.event === "activity" && event.activity;
      li.dataset.status = isActivity ? activityStatus(event.activity) : (EVENT_STATUS[event.event] ?? "ok");
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = clock(event.at);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = isActivity ? `AI: ${humanizeActivity(event.activity)}` : (EVENT_LABELS[event.event] ?? event.event);
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = isActivity
        ? (event.trigger ?? "")
        : `${event.temperatureC.toFixed(1)}° · ${event.humidityPct.toFixed(1)}%`;
      li.append(t, label, val);
      return li;
    },
  );
}

/** Live details' copy of a channel tile -- always the real feed, demo mode or not. */
function writeDetailTile(channel, value, sub, status) {
  const tile = document.querySelector(`#panel-live-details .state-tile[data-channel="${channel}"]`);
  if (tile) setAttr(tile, "data-status", status);
  setText($(`${channel}-value`), value);
  setText($(`${channel}-sub`), sub);
}

/** Live system's copy of a channel tile -- real feed normally, demo engine
 * exclusively while demo mode is active (see setTile). */
function writeSummaryTile(channel, value, sub, status) {
  const tile = document.querySelector(`#panel-live .state-tile[data-channel="${channel}"]`);
  if (tile) setAttr(tile, "data-status", status);
  setText($(`sum-${channel}-value`), value);
  setText($(`sum-${channel}-sub`), sub);
}

function setTile(channel, value, sub, status) {
  writeDetailTile(channel, value, sub, status);
  if (!demoMode) writeSummaryTile(channel, value, sub, status);
}

function writeSummaryTemp(tempC, tempStatus, humPct, humStatus) {
  setText(els.sumTempValue, tempC.toFixed(1));
  setAttr(els.sumTempChip, "data-status", tempStatus);
  setText(els.sumTempChip, tempStatus);
  setAttr(els.sumTempCard, "data-status", tempStatus);
  setText(els.sumHumValue, humPct.toFixed(1));
  setAttr(els.sumHumChip, "data-status", humStatus);
  setText(els.sumHumChip, humStatus);
  setAttr(els.sumHumCard, "data-status", humStatus);
}

function renderClimateTable(points) {
  const rows = points.slice(-MAX_TABLE_ROWS).reverse();
  const signature = `${rows.length}|${rows[0]?.at ?? ""}`;
  if (els.climateTable.dataset.sig === signature) return;
  els.climateTable.dataset.sig = signature;
  const head = "<thead><tr><th>Time</th><th>Temp °C</th><th>Humidity %</th></tr></thead>";
  const body = rows
    .map(
      (p) =>
        `<tr><td>${clock(p.at)}</td><td>${p.temperatureC.toFixed(2)}</td><td>${p.humidityPct.toFixed(2)}</td></tr>`,
    )
    .join("");
  els.climateTable.innerHTML = `${head}<tbody>${body}</tbody>`;
}

/* ── render: server column ───────────────────────────────────────────────── */

/**
 * Physical access: who is in the room, and whether a human allowed it.
 *
 * Reads `snapshot.access`, which is produced by the same AccessSentry the phone
 * talks to -- so the wall and the phone cannot disagree about an open challenge.
 * For an approval surface that is not a nicety: two screens showing different
 * answers to "has this been authorised?" is worse than one screen showing none.
 */
const ACCESS_TEXT = {
  "idle": "Room clear",
  "pending-capture": "Presence detected — awaiting capture",
  "clear": "Authorised person in the room",
  "expected": "On-call on site — escalation suppressed",
  "challenge": "NOT AUTHORISED — unknown person, approval required",
  "unauthorized-during-incident": "NOT AUTHORISED — unknown person during an active incident",
  "anti-passback": "NOT AUTHORISED — in the room with no door entry",
  "tailgating": "NOT AUTHORISED — tailgating, more people than authorised entries",
};

function writeSummaryAccess(severity, chipText, verdictText) {
  setAttr(els.sumAccessCard, "data-status", severity);
  setAttr(els.sumAccessChip, "data-status", severity);
  setText(els.sumAccessChip, chipText);
  setText(els.sumAccessVerdict, verdictText);
}

/**
 * The approval panel's headline, reusing ACCESS_TEXT -- the one verdict →
 * words map this page already has -- rather than a second copy of the same
 * strings. Every verdict that unconditionally requires approval already says
 * "NOT AUTHORISED" above; this only has to cover the one that sometimes
 * doesn't (`pending-capture` reads this way only once its grace period has
 * lapsed unanswered, which is the only way the panel shows for it at all).
 */
function approvalHeadline(verdict) {
  const text = ACCESS_TEXT[verdict] || verdict;
  return text.startsWith("NOT AUTHORISED") ? text : `NOT AUTHORISED — ${text}`;
}

/**
 * The shared secret for the write routes, if the server is running with one.
 *
 * Same convention phone.html uses: taken from the URL once (`?secret=...`)
 * and kept in memory only, never localStorage. The wall's approve/deny
 * buttons go through the same POST /api/access/approve the phone does, so
 * they need to satisfy the same gate the same way.
 */
const ACCESS_SECRET = new URLSearchParams(location.search).get("secret") || "";

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(ACCESS_SECRET ? { "x-access-secret": ACCESS_SECRET } : {}),
    },
    body: JSON.stringify(body),
  });
  let data = {};
  try {
    data = await res.json();
  } catch {
    /* empty body is fine */
  }
  return { ok: res.ok, status: res.status, data };
}

/**
 * Which challenge's photo is already loaded, so the <img> is only pointed at
 * the endpoint again when a NEW challenge starts -- not on every 2s tick
 * while the same one is still open and the underlying bytes have not moved.
 */
let shownPhotoFor = null;

function renderApprovalPanel(a) {
  const pending = a.pending;
  const approval = pending && pending.approval;
  const awaiting = Boolean(approval && approval.state === "pending");

  els.accessApprovalPanel.hidden = !awaiting;
  if (!awaiting) {
    shownPhotoFor = null;
    els.accessApprovalPhoto.hidden = true;
    els.accessApprovalPhoto.removeAttribute("src");
    return;
  }

  setText(els.accessApprovalHeadline, approvalHeadline(pending.verdict));
  setText(els.accessApprovalMeta, `challenge ${pending.id} · awaiting a decision on the wall or the phone`);

  if (shownPhotoFor !== pending.id) {
    shownPhotoFor = pending.id;
    els.accessApprovalPhoto.hidden = false;
    // No cache-buster needed: the server marks this route no-store, and the
    // bytes behind it do not change for the life of one challenge -- this
    // only re-points the <img> when the challenge id itself has changed.
    els.accessApprovalPhoto.src = "/api/access/pending-photo";
    els.accessApprovalPhoto.onerror = () => {
      els.accessApprovalPhoto.hidden = true;
    };
  }
}

/** Record a human decision from the wall, over the same route the phone uses. */
async function submitAccessDecision(decision) {
  const pending = latest && latest.access && latest.access.pending;
  if (!pending) return;
  els.accessApproveBtn.disabled = true;
  els.accessDenyBtn.disabled = true;
  const res = await postJson("/api/access/approve", {
    id: pending.id,
    decision,
    decidedBy: "on-call · wall",
  });
  els.accessApproveBtn.disabled = false;
  els.accessDenyBtn.disabled = false;
  setText(
    els.accessApprovalResult,
    res.ok ? `Recorded: ${decision}.` : res.data.reason || res.data.error || "Could not record that.",
  );
  els.accessApprovalResult.hidden = false;
  clearTimeout(submitAccessDecision._t);
  submitAccessDecision._t = setTimeout(() => {
    els.accessApprovalResult.hidden = true;
  }, 3200);
}

els.accessApproveBtn.addEventListener("click", () => submitAccessDecision("approved"));
els.accessDenyBtn.addEventListener("click", () => submitAccessDecision("denied"));

function renderAccess(snap) {
  const a = snap.access;
  if (!a) return;

  setAttr(els.accessCard, "data-status", a.severity);
  setAttr(els.accessChip, "data-status", a.severity);
  setText(els.accessChip, a.verdict === "idle" ? "clear" : a.verdict.replace(/-/g, " "));
  setText(els.accessVerdict, ACCESS_TEXT[a.verdict] || a.verdict);

  // The known-arrival banner. Tied to the live verdict rather than a
  // one-shot flag on purpose: it renders fresh from a.verdict/a.faces every
  // tick, so it is showing exactly as long as the person is clear in the
  // room and disappears the instant the verdict is no longer "clear" --
  // nothing to age out separately.
  const knownArrivals = (a.faces || [])
    .filter((f) => f.match === "known" && f.name)
    .map((f) => f.name);
  const showWelcome = a.verdict === "clear" && knownArrivals.length > 0;
  els.accessWelcome.hidden = !showWelcome;
  if (showWelcome) setText(els.accessWelcome, `${knownArrivals.join(", ")} just got in`);

  if (!demoMode) {
    writeSummaryAccess(
      a.severity,
      a.verdict === "idle" ? "clear" : a.verdict.replace(/-/g, " "),
      ACCESS_TEXT[a.verdict] || a.verdict,
    );
  }

  const bits = [`identity: ${a.identityMethod}`];
  if (a.doorConsistent === false) bits.push("no door entry");
  bits.push(`entries: ${a.doorOpenCount}`);
  if (a.enrolled && a.enrolled.length) bits.push(`roster: ${a.enrolled.length}`);
  else bits.push("roster: empty");
  if (a.degradedFrom) bits.push(`⚠ ${a.degradedFrom}`);
  setText(els.accessIdentity, bits.join(" · "));

  // renderList keys on the item alone, so the position is folded into the key
  // here -- two unknown faces are distinct rows, not one row rendered twice.
  const faces = (a.faces || []).map((f, i) => ({ ...f, key: `${i}:${f.match}:${f.name || ""}` }));
  renderList(
    els.accessFaces,
    faces,
    (f) => f.key,
    () => {
      const li = document.createElement("li");
      li.className = "access-face";
      return li;
    },
    (li, f) => {
      setAttr(li, "data-match", f.match);
      // A near-miss and a nothing-alike are different facts for whoever is
      // deciding, so the score is shown rather than just the word "unknown".
      setText(li, f.match === "known" ? `${f.name} · ${f.similarity}` : `unknown · best ${f.similarity}`);
    },
  );

  const reasons = (a.reasons || []).map((text, i) => ({ text, key: `${i}:${text}` }));
  renderList(
    els.accessReasons,
    reasons,
    (r) => r.key,
    () => document.createElement("li"),
    (li, r) => setText(li, r.text),
  );

  renderApprovalPanel(a);

  renderList(
    els.accessLog,
    (a.log || []).slice(0, 5),
    (e) => e.id,
    () => document.createElement("li"),
    (li, e) => {
      const state = e.approval.state;
      const decided = state === "approved" ? "approved" : state === "denied" ? "denied" : "undecided";
      setText(li, `${clock(e.at)} · ${ACCESS_TEXT[e.verdict] || e.verdict} · ${decided}`);
      setAttr(li, "data-state", decided);
    },
  );
}

function writeSummaryRisk(score, level, likelyCause, recommendedAction) {
  const riskStatus = RISK_STATUS[level] ?? "unknown";
  setText(els.sumRiskScore, String(score));
  setText(els.sumRiskLevel, level);
  setAttr(els.sumRiskLevel, "data-status", riskStatus);
  els.sumRiskMeter.style.width = `${Math.max(2, Math.min(100, score))}%`;
  setAttr(els.sumRiskMeter, "data-status", riskStatus);
  setAttr(els.sumRiskMeterWrap, "aria-label", `risk index ${score} of 100, ${level}`);
  setText(els.sumLikelyCause, likelyCause);
  setText(els.sumRecommended, recommendedAction);
}

/** Shared by the small Live details family list and the big Live system
 * infra-card list -- and, in demo mode, by the demo engine's own synthetic
 * family array. `family.note`, if present, overrides the default
 * "N sources · simulated" sub-line (the demo engine uses this to show a
 * live-updating percentage instead). */
function renderFamilyList(container, className, families) {
  renderList(
    container,
    families,
    (family) => family.family,
    () => {
      const div = document.createElement("div");
      div.className = className;
      div.innerHTML =
        '<div class="fam-top"><span class="dot"></span><span class="fam-name"></span></div><p class="fam-sub"></p>';
      return div;
    },
    (div, family) => {
      div.dataset.status = family.status;
      setText(div.querySelector(".fam-name"), family.label);
      setText(
        div.querySelector(".fam-sub"),
        family.note ??
          `${family.deviceCount} ${family.deviceCount === 1 ? "source" : "sources"} · ${family.simulated ? "simulated" : "real"}`,
      );
    },
  );
}

function renderServer(snap) {
  const s = snap.server;
  setText(els.serverTitle, s.host);
  setText(els.serverSub, `${s.runtime} · MCP tool servers · world window ${s.worldWindowSeconds}s · seed ${s.worldSeed}`);

  setAttr(els.feedChip, "data-status", snap.feed.connected ? "ok" : "critical");
  setText(els.feedChip, snap.feed.connected ? "receiving" : "no feed");
  els.feedReason.hidden = !snap.feed.reason;
  if (snap.feed.reason) setText(els.feedReason, snap.feed.reason);

  const counts = snap.feed.eventCounts;
  kvRows(els.feedKv, [
    { label: "Sensor log", value: snap.feed.path.split(/[\\/]/).pop(), title: snap.feed.path },
    { label: "Transport", value: snap.feed.transport },
    { label: "Newest line", value: `${clock(snap.feed.lastLineAt)} · ${age(snap.feed.ageSeconds)} ago`, status: snap.feed.connected ? undefined : "critical" },
    { label: "Lines in window", value: `${snap.feed.linesInWindow} (${bytes(snap.feed.fileSizeBytes)})` },
    { label: "Ingested since start", value: String(snap.feed.linesIngested) },
    { label: "Climate ticks", value: String(counts.sensor_tick ?? 0) },
  ]);

  const risk = s.assessment.risk;
  const riskStatus = RISK_STATUS[risk.level] ?? "unknown";
  setText(els.riskScore, String(risk.score));
  setText(els.riskLevel, risk.level);
  setAttr(els.riskLevel, "data-status", riskStatus);
  els.riskMeter.style.width = `${Math.max(2, Math.min(100, risk.score))}%`;
  setAttr(els.riskMeter, "data-status", riskStatus);
  setAttr(els.riskMeterWrap, "aria-label", `risk index ${risk.score} of 100, ${risk.level}`);
  setText(
    els.riskFamilies,
    risk.familiesInvolved.length
      ? `${risk.familiesInvolved.join(", ")} · correlation bonus +${risk.correlationBonus}`
      : "no family outside thresholds",
  );

  if (!demoMode) {
    writeSummaryRisk(risk.score, risk.level, s.assessment.likelyCause, s.assessment.recommendedAction);
  }

  setText(els.confidenceChip, `confidence ${s.assessment.confidence.level}`);
  setText(els.likelyCause, s.assessment.likelyCause);
  setText(els.recommended, s.assessment.recommendedAction);

  setText(els.evidenceCount, s.assessment.evidence.length ? `${s.assessment.evidence.length} signals` : "");
  if (s.assessment.evidence.length === 0) {
    els.evidence.innerHTML = '<li class="empty">Nothing outside thresholds.</li>';
    els.evidence.querySelector("li").dataset.key = "empty";
  } else {
    renderList(
      els.evidence,
      s.assessment.evidence,
      (item) => `${item.family}:${item.signal}`,
      (item) => {
        const li = document.createElement("li");
        li.innerHTML =
          '<span class="sig"><span class="dot"></span><span class="fam"></span><span class="name"></span></span><span class="v"></span>';
        return li;
      },
      (li, item) => {
        li.dataset.status = item.status;
        setText(li.querySelector(".fam"), item.family);
        setText(li.querySelector(".name"), item.signal);
        setText(li.querySelector(".v"), item.value);
        li.title = item.detail;
      },
    );
  }

  const p = s.assessment.provenance;
  const provenanceText =
    `Provenance: environmental ${p.environmental}` +
    (p.ageSeconds !== undefined ? ` (${age(p.ageSeconds)} old)` : "") +
    `; network, storage and compute are simulated` +
    (p.fallbackReason ? `. ${p.fallbackReason}` : ".") +
    ` Confidence reasons: ${s.assessment.confidence.reasons.join("; ")}`;
  setText(els.provenance, provenanceText);
  els.provenance.classList.toggle("note--warn", p.environmental === "mock");

  renderFamilyList(els.families, "family", s.families);

  // Live system summary: network / storage / compute only -- environmental
  // is already the door/temp/humidity tiles above, so repeating it here
  // would just be the same fact twice under a different heading.
  if (!demoMode) {
    const infraFamilies = s.families.filter((family) => family.family !== "physical");
    renderFamilyList(els.sumFamilies, "infra-card", infraFamilies);
    setText(
      els.sumInfraCount,
      `${infraFamilies.reduce((sum, family) => sum + family.deviceCount, 0)} devices reporting`,
    );
  }

  setText(els.sourcesCount, `${s.feeders.length} devices reporting`);
  renderList(
    els.feeders,
    s.feeders,
    (feeder) => feeder.id,
    () => {
      const div = document.createElement("div");
      div.className = "feeder";
      div.innerHTML = '<p class="f-kind"></p><p class="f-label"></p><div class="f-metrics"></div>';
      return div;
    },
    (div, feeder) => {
      div.dataset.status = feeder.status;
      setText(div.querySelector(".f-kind"), `${feeder.kind}${feeder.simulated ? " · sim" : ""}`);
      const label = div.querySelector(".f-label");
      setText(label, feeder.label);
      label.title = feeder.label;
      const metrics = div.querySelector(".f-metrics");
      const html = feeder.metrics.map((m) => `<span class="f-metric">${m.label} <b>${m.value}</b></span>`).join("");
      if (metrics.innerHTML !== html) metrics.innerHTML = html;
    },
  );

  renderList(
    els.pipeline,
    snap.events,
    (event) => event.id,
    (event) => {
      const li = document.createElement("li");
      li.innerHTML = '<span class="t"></span><span class="src"></span><span class="body"><span class="label"></span><span class="detail"></span></span>';
      li.dataset.status = event.status;
      setText(li.querySelector(".t"), clock(event.at));
      const src = li.querySelector(".src");
      src.dataset.source = event.source;
      setText(src, PIPELINE_SOURCE_LABELS[event.source] ?? event.source);
      setText(li.querySelector(".label"), event.label);
      const detail = li.querySelector(".detail");
      detail.textContent = event.detail ?? "";
      detail.title = event.detail ?? "";
      return li;
    },
  );
}

/* ── render: phone column ────────────────────────────────────────────────── */

/** How the inbound path reads in the chat header. */
const INBOUND_LABEL = {
  live: { text: "receiving from phone", status: "ok" },
  starting: { text: "connecting…", status: "unknown" },
  off: { text: "outbound only", status: "unknown" },
  conflict: { text: "inbound blocked", status: "warning" },
  error: { text: "inbound error", status: "warning" },
};

/** Where phone → server messages are coming from, in words rather than a keyword. */
const INBOUND_SOURCE = {
  gateway: "Hermes gateway transcript",
  dedicated: "dedicated wall bot",
  shared: "shared bot",
  none: "",
};

/**
 * The watchdog the server most recently found running, so the captions below can
 * say how long a queued page will actually sit there. Set once per repaint by
 * renderPhone; read by bubbleTag, which the list renderer calls per bubble.
 *
 * Deliberately not a constant: this used to read "next watchdog tick" against a
 * hard-coded "every 5 minutes" note, and both were wrong. The cron path fires
 * every ~2 min (never the configured 1 min) and the loop fires every 15s.
 */
let watchRunner = { mode: "unknown" };

/** "15s" / "2 min", or null when nothing has told us the cadence. */
function watchCadence() {
  if (watchRunner.mode !== "loop" || !watchRunner.intervalMs) return null;
  const s = Math.round(watchRunner.intervalMs / 1000);
  return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}

function bubbleTag(message) {
  if (message.kind === "system") return "wall";
  if (!message.delivered) {
    // Exactly one bubble is a prediction rather than a record: the feed's
    // pending alert, appended with the fixed id "pending". Every other
    // undelivered watchdog bubble is a page that has already fired and whose
    // delivery the watchdog has not confirmed — tagging that "queued" would
    // claim it is still coming when it has in fact been attempted. The bubble
    // text carries the specific reason (in flight, failed, or unobservable).
    if (message.origin !== "watchdog" || message.id !== "pending") return "not delivered";
    const cadence = watchCadence();
    return cadence ? `queued · next tick ≤ ${cadence}` : "queued · next watchdog tick";
  }
  return message.direction === "inbound"
    ? `phone → server · ${message.origin}`
    : `server → phone · ${message.origin}`;
}

/**
 * A thread with nothing in it is ambiguous — quiet system, or broken panel? Say
 * which. This was the actual complaint: the panel looked dead because no traffic
 * source was wired to it, and nothing on screen admitted that.
 */
function renderThreadPlaceholder(t, container) {
  const real = t.messages.filter((m) => m.kind !== "system").length;
  let node = container.querySelector(".tg-placeholder");
  if (real > 0) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement("li");
    node.className = "tg-placeholder";
    container.append(node);
  } else {
    container.append(node);
  }
  const inboundOff = t.inbound?.mode !== "live";
  setText(
    node,
    inboundOff
      ? "No messages yet. Outbound pages appear here as they are sent; phone → server messages need an inbound source (see below)."
      : "No messages yet. Both directions are wired — server → phone on the left, phone → server on the right, as soon as either carries anything.",
  );
}

/** Shared by the detailed dashboard's thread and the Live system summary's
 * mirror of it -- same bubbles, same tags, two containers. */
function renderBubbles(container, messages) {
  renderList(
    container,
    messages,
    (message) => message.id,
    (message) => {
      const li = document.createElement("li");
      li.innerHTML = '<span class="bubble-text"></span><span class="bubble-meta"><span class="bubble-time"></span><span class="bubble-tag"></span></span>';
      return li;
    },
    (li, message) => {
      const classes = ["bubble"];
      if (message.direction === "inbound") classes.push("bubble--inbound");
      if (message.kind === "alert") classes.push("bubble--alert");
      if (message.kind === "recovery") classes.push("bubble--recovery");
      if (message.kind === "system") classes.push("bubble--system");
      if (!message.delivered) classes.push("bubble--pending");
      if (li.classList.contains("enter")) classes.push("enter");
      const className = classes.join(" ");
      if (li.className !== className) li.className = className;
      setText(li.querySelector(".bubble-text"), message.text);
      setText(li.querySelector(".bubble-time"), clock(message.at));
      // Direction is spelled out, not left to which side the bubble sits on.
      // Someone reading this across a room needs the arrow, and a screenshot of
      // a single bubble has no other side to compare against.
      setText(li.querySelector(".bubble-tag"), bubbleTag(message));
    },
  );
}

function renderPhone(snap) {
  const t = snap.telegram;
  // Before the thread renders: bubbleTag reads this for the queued-bubble tag.
  watchRunner = t.watchdog.runner ?? { mode: "unknown" };
  const inbound = t.inbound ?? { mode: "off", detail: "", bot: "none" };
  const label = INBOUND_LABEL[inbound.mode] ?? INBOUND_LABEL.off;
  setText(els.tgBot, t.botLabel);
  setText(els.tgSub, `${t.chatTitle} · ${label.text}`);
  setAttr(els.tgSub, "data-status", label.status);
  els.tgSub.title = inbound.detail || t.chatTitle;

  const messages = [...t.messages];
  if (t.pending) messages.push(t.pending);

  renderBubbles(els.tgThread, messages);
  renderThreadPlaceholder(t, els.tgThread);

  // Keep the anchor the last child through the diff above, same trick
  // renderThreadPlaceholder uses -- append() moves an already-attached node
  // rather than duplicating it.
  els.tgThread.append(tgAnchor);

  const justBecameVisible = !phoneEverVisible && els.tgThread.clientHeight > 0;
  if (justBecameVisible) phoneEverVisible = true;
  // "auto" (instant), not "smooth": a burst of several messages in one tick --
  // a batch of watchdog alerts, a reconnect replaying backlog -- fires this on
  // every one of them, and each smooth scroll restarts the animation from
  // wherever the last one had gotten to, so the view visibly chases the
  // bottom for seconds after the messages themselves have stopped arriving.
  // Instant positioning has no animation to interrupt, so it is always
  // exactly caught up by the next tick.
  if (phoneAtBottom || justBecameVisible) {
    tgAnchor.scrollIntoView({ behavior: "auto", block: "end" });
  }

  // Live system's phone mirror -- same messages, same bot header, no anchor
  // tracking: it's a secondary view, so a plain scrollTop-to-bottom on every
  // tick is enough, without the visibility bookkeeping the primary thread
  // above needs to survive being hidden mid-tick. Skipped entirely in demo
  // mode, which owns this thread instead (see demoTick).
  if (!demoMode) {
    setText(els.sumTgBot, t.botLabel);
    setText(els.sumTgSub, `${t.chatTitle} · ${label.text}`);
    setAttr(els.sumTgSub, "data-status", label.status);
    els.sumTgSub.title = inbound.detail || t.chatTitle;
    renderBubbles(els.sumTgThread, messages);
    renderThreadPlaceholder(t, els.sumTgThread);
    els.sumTgThread.scrollTop = els.sumTgThread.scrollHeight;
  }

  const newestInbound = [...t.messages].reverse().find((m) => m.direction === "inbound");
  if (newestInbound) {
    const ms = Date.parse(newestInbound.at);
    if (!Number.isNaN(ms)) lastInboundAt = ms;
  }

  setAttr(els.watchdogChip, "data-status", t.watchdog.lastStatus);
  setText(els.watchdogChip, t.watchdog.lastStatus);
  kvRows(els.watchdogKv, [
    { label: "Persisted status", value: t.watchdog.lastStatus, status: t.watchdog.lastStatus },
    {
      label: "Last delivery",
      value: t.watchdog.lastAlertedAt
        ? `${clock(t.watchdog.lastAlertedAt)} · ${age(t.watchdog.lastAlertAgeSeconds)} ago`
        : "none on record",
    },
    { label: "State file", value: t.watchdog.stateFound ? "found" : "missing", status: t.watchdog.stateFound ? undefined : "warning" },
    {
      // Probed, not configured. A watchdog nobody can see is indistinguishable
      // from one that died, and that is the single most expensive thing this
      // panel could get wrong.
      label: "Watchdog process",
      value:
        watchRunner.mode === "loop"
          ? `loop · every ${watchCadence() ?? "?"}${watchRunner.canDeliver === false ? " · cannot page" : ""}`
          : "no loop detected",
      status:
        watchRunner.mode === "loop"
          ? watchRunner.canDeliver === false
            ? "warning"
            : undefined
          : "warning",
      title:
        watchRunner.detail ??
        (watchRunner.ticks !== undefined ? `${watchRunner.ticks} ticks since start` : ""),
    },
    { label: "Real messages", value: String(t.ingestedCount) },
    {
      label: "Phone → server",
      value: `${label.text}${INBOUND_SOURCE[inbound.bot] ? ` (${INBOUND_SOURCE[inbound.bot]})` : ""}`,
      status: label.status === "unknown" ? undefined : label.status,
      title: inbound.detail,
    },
  ]);
  const cadence = watchCadence();
  const cadenceNote =
    watchRunner.mode === "loop"
      ? `The watchdog loop re-checks every ${cadence ?? "tick"}.`
      : "No watchdog loop is answering on the health port, so paging is on the hermes cron path (~2 min per tick) or is not running at all.";
  setText(
    els.watchdogNote,
    inbound.mode === "live"
      ? `${cadenceNote} It pushes only on a threshold crossing or a recovery — silence is the normal state. A queued bubble is what the next tick will send, not something the phone has received.`
      : `${inbound.detail} — outbound pages still appear here the moment they are sent.`,
  );
}

/* ── render: conduits ────────────────────────────────────────────────────── */

function renderConduits(snap) {
  // Conduit captions are set vertically, so they have to stay short -- a long
  // string here grows downward and gets clipped by the rail.
  const feedUp = snap.feed.connected;
  setAttr(els.conduitIn, "data-state", feedUp ? "live" : "down");
  setText(els.conduitInFoot, feedUp ? `${age(snap.feed.ageSeconds)} ago` : "feed down");

  const inboundRecent = Date.now() - lastInboundAt < INBOUND_GLOW_MS;
  setAttr(els.conduitOut, "data-inbound", String(inboundRecent));
  setAttr(els.conduitOut, "data-state", "live");
  setText(els.conduitOutFoot, snap.telegram.pending ? "alert queued" : `${snap.telegram.messages.length} msgs`);
}

/* ── stream ──────────────────────────────────────────────────────────────── */

function render(snap) {
  latest = snap;
  renderHeader(snap);
  renderDevice(snap);
  renderAccess(snap);
  renderServer(snap);
  renderPhone(snap);
  renderConduits(snap);
}

// The real SSE state, tracked even while demo mode is drawing over it, so
// turning demo mode off can restore the actual connection state instantly
// instead of guessing at it.
let realConnState = { state: "connecting", label: "connecting" };

function setConnection(state, label) {
  realConnState = { state, label };
  if (demoMode) return; // demo mode owns the indicator while it's running
  setAttr(els.conn, "data-state", state);
  setText(els.connLabel, label);
}

function connect() {
  const source = new EventSource("/api/stream");
  source.addEventListener("open", () => setConnection("live", "live"));
  source.addEventListener("message", (event) => {
    setConnection("live", "live");
    try {
      render(JSON.parse(event.data));
    } catch (err) {
      console.error("bad snapshot", err);
    }
  });
  // EventSource reconnects on its own; the label just has to stop claiming live.
  source.addEventListener("error", () => setConnection("lost", "reconnecting"));
}

// Charts are sized from their container, so a resize needs a redraw. Sparklines
// self-skip when nothing changed, which is why this can be a plain re-render.
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (latest) {
      els.tempSpark.dataset.sig = "";
      els.humSpark.dataset.sig = "";
      render(latest);
    }
  }, 150);
});

/* ── Demo mode ────────────────────────────────────────────────────────────
 *
 * A scripted loop for presenting Hermes without betting the demo on real
 * sensor conditions cooperating. It only ever writes to the Live system
 * summary elements (via writeSummaryTile / writeSummaryTemp /
 * writeSummaryAccess / writeSummaryRisk / renderFamilyList / renderBubbles)
 * -- the same functions the real feed uses, guarded everywhere above by
 * `if (!demoMode)`. Live details never checks this flag, so it always shows
 * the real feed no matter what the summary is doing.
 *
 * Three self-contained scenarios, each a full inbound-instruction ->
 * simulated-deviation -> outbound-alert story, run back to back (10s each),
 * then a 30s pause holding the last resting state before the loop repeats.
 * Only the active scenario's channel deviates; everything else shows a calm
 * baseline, so a room watching never has more than one thing going on.
 */
const DEMO_SCENARIO_MS = 10_000;
const DEMO_GAP_MS = 10_000;
const DEMO_PAUSE_MS = 30_000;
const DEMO_STARTUP_MS = 10_000;
const DEMO_TICK_MS = 400;

// One-time 10s quiet beat before scenario 1 (so the tab doesn't launch
// straight into an alert the instant someone opens it), then the three
// scenarios with a 10s gap between each, then the 30s pause, then repeat.
const DEMO_TIMELINE = [
  { type: "scenario", index: 0, duration: DEMO_SCENARIO_MS },
  { type: "gap", duration: DEMO_GAP_MS },
  { type: "scenario", index: 1, duration: DEMO_SCENARIO_MS },
  { type: "gap", duration: DEMO_GAP_MS },
  { type: "scenario", index: 2, duration: DEMO_SCENARIO_MS },
  { type: "pause", duration: DEMO_PAUSE_MS },
];
const DEMO_CYCLE_MS = DEMO_TIMELINE.reduce((sum, phase) => sum + phase.duration, 0);

const DEMO_SCENARIOS = [
  {
    inbound: "Notify me when the Temperature or Humidity deviates from the normal baseline by ±20%.",
    outboundKind: "alert",
    outboundText: ({ temp, hum, devPct }) =>
      `Environmental alert: temperature ${temp.toFixed(1)}°C (+${devPct}% vs baseline), humidity ${hum.toFixed(1)}% (−${devPct}% vs baseline) — exceeds your ±20% threshold.`,
  },
  {
    inbound: "Notify me when the door is opened and an object is detected.",
    outboundKind: "alert",
    outboundText: () => "Door opened and an object was detected passing through.",
  },
  {
    inbound:
      "If available storage decreases below 5% then clear the log files from the server and restart services, then notify me of the issue and actions taken.",
    outboundKind: "recovery",
    outboundText: ({ pct }) =>
      `Storage alert: available capacity dropped to 3% (below your 5% threshold). Cleared log files and restarted services — capacity restored to ${pct.toFixed(0)}%.`,
  },
];

let demoTimerId = null;
let demoCycleStart = 0;
let demoRun = { cycle: -1, pos: -1, inboundFired: false, outboundFired: false, envBaseline: null };
let demoMessages = [];
let demoMsgSeq = 0;

/** Which timeline phase `elapsedInCycle` falls in, plus `pos` (its index in
 * DEMO_TIMELINE, used to detect "we moved to a new phase") and `progress`
 * (0..1 through that phase's own duration). */
function demoPhaseAt(elapsedInCycle) {
  let start = 0;
  for (let pos = 0; pos < DEMO_TIMELINE.length; pos++) {
    const phase = DEMO_TIMELINE[pos];
    if (elapsedInCycle < start + phase.duration) {
      return { ...phase, pos, progress: (elapsedInCycle - start) / phase.duration };
    }
    start += phase.duration;
  }
  const pos = DEMO_TIMELINE.length - 1;
  return { ...DEMO_TIMELINE[pos], pos, progress: 1 };
}

function pushDemoMessage(direction, kind, text) {
  demoMsgSeq += 1;
  demoMessages.push({
    id: `demo-${demoMsgSeq}`,
    direction,
    kind,
    delivered: true,
    origin: "demo",
    text,
    at: new Date().toISOString(),
  });
  if (demoMessages.length > 12) demoMessages = demoMessages.slice(-12);
}

// Fixed, never read from `latest`: the whole point of demo mode is a script
// that doesn't depend on the real feed's current (possibly already
// elevated, possibly stale-mock) reading. Device counts below are the one
// exception -- those are structural, not volatile, so borrowing the real
// ones just makes the demo look more like this specific rig.
const DEMO_BASELINE_TEMP_C = 21.5;
const DEMO_BASELINE_HUM_PCT = 45;

/** Real device counts where we have them (so the numbers look authentic),
 * demo-controlled status/note where it matters. */
function demoFamilies({ storageStatus, storageNote }) {
  const real = latest?.server?.families ?? [];
  const countFor = (key, fallback) => real.find((f) => f.family === key)?.deviceCount ?? fallback;
  return [
    { family: "network", label: "Network", status: "ok", deviceCount: countFor("network", 5), simulated: true },
    {
      family: "storage",
      label: "Storage",
      status: storageStatus,
      deviceCount: countFor("storage", 4),
      simulated: true,
      note: storageNote,
    },
    { family: "compute", label: "Compute", status: "ok", deviceCount: countFor("compute", 6), simulated: true },
  ];
}

function demoDeviceTotal() {
  return demoFamilies({ storageStatus: "ok", storageNote: null }).reduce((sum, f) => sum + f.deviceCount, 0);
}

/** Calm baseline for every field the active scenario isn't currently telling
 * a story about. Re-applied once per (cycle, scenario) transition, before
 * that scenario's own tick starts layering its deviation on top. */
function demoResting() {
  writeSummaryTile("door", "Closed", "steady", "ok");
  writeSummaryTile("light", "Off", "steady", "ok");
  writeSummaryTile("leak", "Dry", "no leak", "ok");
  writeSummaryTile("presence", "Clear", "steady", "ok");
  writeSummaryTemp(DEMO_BASELINE_TEMP_C, "ok", DEMO_BASELINE_HUM_PCT, "ok");
  writeSummaryAccess("ok", "clear", "Room clear");
  writeSummaryRisk(0, "low", "No incident detected. All evaluated families are within thresholds.", "No action required.");
  renderFamilyList(els.sumFamilies, "infra-card", demoFamilies({ storageStatus: "ok", storageNote: null }));
  setText(els.sumInfraCount, `${demoDeviceTotal()} devices reporting`);
}

/** Pure -- no DOM writes -- so the guaranteed-fire fallback in demoTick can
 * compute "what the numbers were at the end" without re-touching a tile
 * that now belongs to a later phase. */
function demoEnvCompute(progress, baseline) {
  const dev = 0.22 * progress;
  const temp = baseline.t * (1 + dev);
  const hum = Math.max(5, baseline.h * (1 - dev));
  const status = dev >= 0.2 ? "critical" : dev >= 0.12 ? "warning" : "ok";
  const score = Math.round((dev / 0.22) * 66);
  const level = dev >= 0.2 ? "high" : dev >= 0.1 ? "medium" : "low";
  return { temp, hum, status, score, level, devPct: Math.round(dev * 100) };
}

function demoEnvTick(progress) {
  if (!demoRun.envBaseline) {
    demoRun.envBaseline = { t: DEMO_BASELINE_TEMP_C, h: DEMO_BASELINE_HUM_PCT };
  }
  const r = demoEnvCompute(progress, demoRun.envBaseline);
  writeSummaryTemp(r.temp, r.status, r.hum, r.status);
  writeSummaryRisk(
    r.score,
    r.level,
    "Environmental drift: temperature trending high, humidity trending low.",
    r.level === "high" ? "Investigate HVAC — deviation exceeds the ±20% threshold." : "Monitoring — no action required yet.",
  );
  return r;
}

function demoDoorTick(progress) {
  const doorOpen = progress >= 0.2;
  const objectDetected = progress >= 0.55;
  writeSummaryTile(
    "door",
    doorOpen ? "Open" : "Closed",
    doorOpen ? `open ${Math.max(0, Math.round((progress - 0.2) * 10))}s` : "steady",
    doorOpen ? "warning" : "ok",
  );
  writeSummaryTile(
    "presence",
    objectDetected ? "Present" : "Clear",
    objectDetected ? "object detected" : "steady",
    objectDetected ? "warning" : "ok",
  );
  if (objectDetected) {
    writeSummaryRisk(
      52,
      "medium",
      "Door opened and an object was detected passing through.",
      "Confirm expected personnel or dispatch the on-call.",
    );
  } else if (doorOpen) {
    writeSummaryRisk(18, "low", "Door opened — awaiting presence confirmation.", "Monitoring the opening.");
  } else {
    writeSummaryRisk(0, "low", "No incident detected. All evaluated families are within thresholds.", "No action required.");
  }
  return {};
}

/** Pure -- see demoEnvCompute. */
// The drop (100% -> 3%) takes the first 62.5% of the window; the recovery
// (3% -> 92%) takes the remaining 37.5% -- 25% longer than the original
// 30%/70% split (0.3 * 1.25 = 0.375), so the climb back up reads less like
// a snap and more like a system actually doing the work.
const DEMO_STORAGE_SPLIT = 0.625;

function demoStorageCompute(progress) {
  const pct =
    progress <= DEMO_STORAGE_SPLIT
      ? 100 - (progress / DEMO_STORAGE_SPLIT) * 97
      : 3 + ((progress - DEMO_STORAGE_SPLIT) / (1 - DEMO_STORAGE_SPLIT)) * 89;
  const status = pct <= 5 ? "critical" : pct <= 20 ? "warning" : "ok";
  const remediating = progress > DEMO_STORAGE_SPLIT;
  const score = status === "critical" ? 74 : status === "warning" ? 38 : remediating ? 12 : 0;
  const level = status === "critical" ? "critical" : status === "warning" ? "medium" : "low";
  // Wording matters: Hermes is read-only and never executes remediation itself,
  // so even this scripted demo scenario must say "recommended" and "operator",
  // never claim the system cleared logs or restarted services on its own.
  const cause =
    pct <= 5
      ? "Storage capacity critical — remediation recommended, operator action required."
      : remediating
        ? "Storage capacity recovering in this simulated scenario after operator remediation."
        : "Storage capacity trending down.";
  const action =
    pct <= 5 || remediating
      ? "Recommended: clear log files and restart services. Hermes advises; the operator acts."
      : "Monitoring storage trend.";
  return { pct, status, remediating, score, level, cause, action };
}

function demoStorageTick(progress) {
  const r = demoStorageCompute(progress);
  const note = `${r.pct.toFixed(0)}% available · ${r.remediating ? "restoring" : r.status}`;
  renderFamilyList(els.sumFamilies, "infra-card", demoFamilies({ storageStatus: r.status, storageNote: note }));
  writeSummaryRisk(r.score, r.level, r.cause, r.action);
  return r;
}

function renderDemoPlaceholder() {
  const container = els.sumTgThread;
  let node = container.querySelector(".tg-placeholder");
  if (demoMessages.length > 0) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement("li");
    node.className = "tg-placeholder";
    container.append(node);
  }
  setText(node, "Demo starting — the first scripted message will appear here shortly.");
}

/** What a scenario's outbound message should say if we have to fire it from
 * the transition catch-all below, i.e. computed at progress 1 without going
 * through the writer functions (we're no longer in that scenario's phase,
 * so nothing should be re-touching its tiles). */
function demoFinalResult(scenarioIndex) {
  if (scenarioIndex === 0) {
    return demoEnvCompute(1, demoRun.envBaseline ?? { t: DEMO_BASELINE_TEMP_C, h: DEMO_BASELINE_HUM_PCT });
  }
  if (scenarioIndex === 2) return demoStorageCompute(1);
  return {};
}

function demoTick() {
  if (!demoMode) return;
  const elapsedTotal = Date.now() - demoCycleStart;

  // One-time quiet beat before the very first scenario of this demo
  // session: the tab shouldn't launch straight into an alert the instant
  // someone opens it.
  if (elapsedTotal < 0) {
    demoResting();
    renderBubbles(els.sumTgThread, demoMessages);
    renderDemoPlaceholder();
    setText(els.sumTgBot, "Hermes Ops");
    setText(els.sumTgSub, "Demo mode · scripted scenario");
    return;
  }

  const cycle = Math.floor(elapsedTotal / DEMO_CYCLE_MS);
  const elapsedInCycle = elapsedTotal - cycle * DEMO_CYCLE_MS;
  const phase = demoPhaseAt(elapsedInCycle);

  const transitioned = cycle !== demoRun.cycle || phase.pos !== demoRun.pos;
  if (transitioned) {
    // Guaranteed catch-all: whichever scenario we're leaving must have paged
    // by now no matter what -- a backgrounded tab throttles setInterval and
    // can skip straight over the in-window fire below without this.
    if (demoRun.pos >= 0) {
      const leaving = DEMO_TIMELINE[demoRun.pos];
      if (leaving.type === "scenario" && demoRun.inboundFired && !demoRun.outboundFired) {
        const leavingScenario = DEMO_SCENARIOS[leaving.index];
        pushDemoMessage(
          "outbound",
          leavingScenario.outboundKind,
          leavingScenario.outboundText(demoFinalResult(leaving.index)),
        );
      }
    }
    demoRun.cycle = cycle;
    demoRun.pos = phase.pos;
    demoRun.inboundFired = false;
    demoRun.outboundFired = false;
    if (phase.type === "scenario" && phase.index === 0) demoRun.envBaseline = null;
  }

  // Gaps and the pause hold a clean calm state -- resting() runs every tick
  // while in one of those, not just once on the way in.
  if (phase.type !== "scenario" || transitioned) demoResting();

  if (phase.type === "scenario") {
    const scenario = DEMO_SCENARIOS[phase.index];
    if (!demoRun.inboundFired) {
      pushDemoMessage("inbound", null, scenario.inbound);
      demoRun.inboundFired = true;
    }

    const result =
      phase.index === 0
        ? demoEnvTick(phase.progress)
        : phase.index === 1
          ? demoDoorTick(phase.progress)
          : demoStorageTick(phase.progress);

    // 0.9, not 1.0: the common-case early fire, so the room has a moment to
    // read the alert before the scenario visibly ends. The transition
    // catch-all above is what actually guarantees it fires at all.
    if (phase.progress >= 0.9 && !demoRun.outboundFired) {
      pushDemoMessage("outbound", scenario.outboundKind, scenario.outboundText(result));
      demoRun.outboundFired = true;
    }
  }

  renderBubbles(els.sumTgThread, demoMessages);
  renderDemoPlaceholder();
  els.sumTgThread.scrollTop = els.sumTgThread.scrollHeight;
  setText(els.sumTgBot, "Hermes Ops");
  setText(els.sumTgSub, "Demo mode · scripted scenario");
}

function updateDemoUI() {
  setAttr(els.demoToggle, "aria-pressed", String(demoMode));
  els.demoToggle.dataset.mode = demoMode ? "demo" : "live";
  setText(els.demoToggleLabel, demoMode ? "Demo" : "Live");
  els.demoBadge.hidden = !demoMode;
  // The header's connection dot is global, same as the badge: demo mode
  // overrides it to an amber "Demo" so it can't be misread as the real feed
  // being live, and stopping demo mode restores whatever the real SSE
  // connection is actually doing right now, not just "live" by default.
  if (demoMode) {
    setAttr(els.conn, "data-state", "demo");
    setText(els.connLabel, "Demo");
  } else {
    setAttr(els.conn, "data-state", realConnState.state);
    setText(els.connLabel, realConnState.label);
  }
}

function startDemoMode() {
  if (demoMode) return;
  demoMode = true;
  // Pushed DEMO_STARTUP_MS into the future, not "now": demoTick() reads a
  // negative elapsedTotal for that first stretch and holds a calm resting
  // state instead of launching straight into scenario 1.
  demoCycleStart = Date.now() + DEMO_STARTUP_MS;
  demoRun = { cycle: -1, pos: -1, inboundFired: false, outboundFired: false, envBaseline: null };
  demoMessages = [];
  demoMsgSeq = 0;
  updateDemoUI();
  demoTick();
  demoTimerId = setInterval(demoTick, DEMO_TICK_MS);
}

function stopDemoMode() {
  if (!demoMode) return;
  demoMode = false;
  if (demoTimerId) {
    clearInterval(demoTimerId);
    demoTimerId = null;
  }
  updateDemoUI();
  // demoMode is already false, so this repopulates the summary from
  // whatever the real feed most recently reported -- no separate reset path.
  if (latest) render(latest);
}

els.demoToggle.addEventListener("click", () => {
  if (demoMode) stopDemoMode();
  else startDemoMode();
});

/* ── Live system phone height ─────────────────────────────────────────────
 *
 * The phone's bottom edge tracks the left column's bottom edge by measured
 * geometry, not CSS stretch (see .live-split in styles.css for why stretch
 * alone lets an overflowing message thread inflate the whole row). Recomputed
 * whenever the left column resizes, and once when the tab becomes visible --
 * getBoundingClientRect reads 0 for a display:none ancestor, so a resize
 * that happens while the tab is hidden has nothing to measure yet.
 */
const liveSplitLeft = document.querySelector(".live-split-left");
const liveSplitPhoneFrame = document.querySelector(".live-split-right .phone-frame");

function syncPhoneHeight() {
  if (!liveSplitLeft || !liveSplitPhoneFrame) return;
  const leftRect = liveSplitLeft.getBoundingClientRect();
  const frameRect = liveSplitPhoneFrame.getBoundingClientRect();
  if (leftRect.height === 0 || frameRect.height === 0) return;
  const height = leftRect.bottom - frameRect.top;
  if (height > 100) liveSplitPhoneFrame.style.height = `${height}px`;
}

if (liveSplitLeft && "ResizeObserver" in window) {
  new ResizeObserver(syncPhoneHeight).observe(liveSplitLeft);
}

/* ── Tabs ────────────────────────────────────────────────────────────────── */

const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
const tabPanels = {
  overview: $("panel-overview"),
  architecture: $("panel-architecture"),
  logical: $("panel-logical"),
  live: $("panel-live"),
  "live-details": $("panel-live-details"),
  detailed: $("panel-detailed"),
};

function activateTab(name) {
  if (!tabPanels[name]) return;
  for (const btn of tabButtons) {
    const active = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(active));
    btn.tabIndex = active ? 0 : -1;
    btn.classList.toggle("active", active);
  }
  for (const [key, panel] of Object.entries(tabPanels)) {
    panel.classList.toggle("active", key === name);
  }
  // Sparklines size themselves from their container, which is 0px wide while
  // Live details is hidden -- force a redraw now that it has real width. The
  // Live system summary tab has no sparklines, so it doesn't need this.
  if (name === "live-details" && latest) {
    els.tempSpark.dataset.sig = "";
    els.humSpark.dataset.sig = "";
    render(latest);
  }
  // Live system defaults to the scripted demo rather than whatever the real
  // room happens to be doing -- a no-op if it's already running, so this
  // never restarts an in-progress loop, only starts one that isn't.
  if (name === "live") {
    startDemoMode();
    syncPhoneHeight();
  }
}

for (const btn of tabButtons) {
  btn.addEventListener("click", () => activateTab(btn.dataset.tab));
}

// Standard tablist keyboard pattern: arrow keys move focus and selection
// together between tabs.
document.querySelector(".tabnav")?.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
  const i = tabButtons.indexOf(document.activeElement);
  if (i === -1) return;
  const next =
    event.key === "ArrowRight" ? (i + 1) % tabButtons.length : (i - 1 + tabButtons.length) % tabButtons.length;
  event.preventDefault();
  tabButtons[next].focus();
  activateTab(tabButtons[next].dataset.tab);
});

connect();
