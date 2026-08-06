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
  livePanel: $("panel-live"),
  liveDetailsPanel: $("panel-live-details"),

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
  accessIdentity: $("access-identity"),
  accessFaces: $("access-faces"),
  accessReasons: $("access-reasons"),
  accessApproval: $("access-approval"),
  accessLog: $("access-log"),
  deviceLogCount: $("device-log-count"),
  tempValue: $("temp-value"),
  tempChip: $("temp-chip"),
  tempSpark: $("temp-spark"),
  tempNote: $("temp-note"),
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
};

/** The board's raw event vocabulary, in words a judge can read off the wall. */
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

const RISK_STATUS = { low: "ok", medium: "warning", high: "serious", critical: "critical" };
const STATUS_ICON = { ok: "#i-check", warning: "#i-warn", critical: "#i-crit", unknown: "#i-unknown" };

let latest = null;
let lastInboundAt = 0;

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
 * panel lives on the "Live system" tab, and a `display:none` tab's contents
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
  setText(els.humValue, d.humidityPct.toFixed(1));
  setAttr(els.humChip, "data-status", d.humidityStatus);
  setText(els.humChip, d.humidityStatus);

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
      li.dataset.status = EVENT_STATUS[event.event] ?? "ok";
      const t = document.createElement("span");
      t.className = "t";
      t.textContent = clock(event.at);
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = EVENT_LABELS[event.event] ?? event.event;
      const val = document.createElement("span");
      val.className = "val";
      val.textContent = `${event.temperatureC.toFixed(1)}° · ${event.humidityPct.toFixed(1)}%`;
      li.append(t, label, val);
      return li;
    },
  );
}

function setTile(channel, value, sub, status) {
  const tile = document.querySelector(`.state-tile[data-channel="${channel}"]`);
  setAttr(tile, "data-status", status);
  setText($(`${channel}-value`), value);
  setText($(`${channel}-sub`), sub);
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
 * Physical access: who is at the rack, and whether a human allowed it.
 *
 * Reads `snapshot.access`, which is produced by the same AccessSentry the phone
 * talks to -- so the wall and the phone cannot disagree about an open challenge.
 * For an approval surface that is not a nicety: two screens showing different
 * answers to "has this been authorised?" is worse than one screen showing none.
 */
const ACCESS_TEXT = {
  "idle": "Rack clear",
  "pending-capture": "Presence detected — awaiting capture",
  "clear": "Authorised person at the rack",
  "expected": "On-call on site — escalation suppressed",
  "challenge": "Unknown person — approval required",
  "unauthorized-during-incident": "Unknown person during an active incident",
  "anti-passback": "At the rack with no door entry",
  "tailgating": "Tailgating — more people than authorised entries",
};

function renderAccess(snap) {
  const a = snap.access;
  if (!a) return;

  setAttr(els.accessCard, "data-status", a.severity);
  setAttr(els.accessChip, "data-status", a.severity);
  setText(els.accessChip, a.verdict === "idle" ? "clear" : a.verdict.replace(/-/g, " "));
  setText(els.accessVerdict, ACCESS_TEXT[a.verdict] || a.verdict);

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

  const approval = a.pending && a.pending.approval;
  const awaiting = approval && approval.state === "pending";
  els.accessApproval.hidden = !approval || approval.state === "not-required";
  if (approval && approval.state !== "not-required") {
    setText(
      els.accessApproval,
      awaiting
        ? `Awaiting authorisation on the on-call phone · challenge ${a.pending.id}`
        : `${approval.state === "approved" ? "Approved" : "DENIED"} by ${approval.decidedBy || "a human"}`,
    );
  }

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

  renderList(
    els.families,
    s.families,
    (family) => family.family,
    () => {
      const div = document.createElement("div");
      div.className = "family";
      div.innerHTML =
        '<div class="fam-top"><span class="dot"></span><span class="fam-name"></span></div><p class="fam-sub"></p>';
      return div;
    },
    (div, family) => {
      div.dataset.status = family.status;
      setText(div.querySelector(".fam-name"), family.label);
      setText(
        div.querySelector(".fam-sub"),
        `${family.deviceCount} ${family.deviceCount === 1 ? "source" : "sources"} · ${family.simulated ? "simulated" : "real"}`,
      );
    },
  );

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
      setText(src, event.source === "physical" ? "sensor" : event.source);
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
    if (message.origin !== "watchdog") return "not delivered";
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
function renderThreadPlaceholder(t) {
  const real = t.messages.filter((m) => m.kind !== "system").length;
  let node = els.tgThread.querySelector(".tg-placeholder");
  if (real > 0) {
    if (node) node.remove();
    return;
  }
  if (!node) {
    node = document.createElement("li");
    node.className = "tg-placeholder";
    els.tgThread.append(node);
  } else {
    els.tgThread.append(node);
  }
  const inboundOff = t.inbound?.mode !== "live";
  setText(
    node,
    inboundOff
      ? "No messages yet. Outbound pages appear here as they are sent; phone → server messages need an inbound source (see below)."
      : "No messages yet. Both directions are wired — server → phone on the left, phone → server on the right, as soon as either carries anything.",
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

  renderList(
    els.tgThread,
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

  renderThreadPlaceholder(t);

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

/**
 * "Live details" is a mirror of the "Live system" tab, not a second
 * independently-rendered view: re-running every render* function against a
 * second `els` scope would double the diffing cost every 2s tick for a tab
 * that is, by request, identical to the one next to it. A structural clone
 * of the already-rendered panel is cheaper and can't drift from it.
 *
 * The clone duplicates element ids (door-value, temp-chip, ...) into the
 * document. That's safe here only because panel-live-details is placed
 * after panel-live in the DOM: `getElementById` and the `$(...)` lookups
 * above always resolve to the first match in document order, so every
 * existing `els.*` reference keeps pointing at the original, live-bound
 * elements -- the clone is inert, display-only. Interactions wired via
 * `addEventListener` on specific nodes (sparkline hover tooltips, the
 * phone-thread auto-scroll observer) aren't cloned, so this tab shows the
 * same data without those hover/scroll behaviors.
 */
function syncLiveDetails() {
  if (!els.liveDetailsPanel) return;
  els.liveDetailsPanel.replaceChildren(...els.livePanel.cloneNode(true).childNodes);
}

function render(snap) {
  latest = snap;
  renderHeader(snap);
  renderDevice(snap);
  renderAccess(snap);
  renderServer(snap);
  renderPhone(snap);
  renderConduits(snap);
  syncLiveDetails();
}

function setConnection(state, label) {
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
  // the live tab is hidden -- force a redraw now that it has real width.
  // Live details mirrors panel-live's own sparklines (see `syncLiveDetails`),
  // so it needs the same forced redraw whenever it's the one being switched to.
  if ((name === "live" || name === "live-details") && latest) {
    els.tempSpark.dataset.sig = "";
    els.humSpark.dataset.sig = "";
    render(latest);
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
