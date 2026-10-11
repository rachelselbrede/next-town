// Next Town frontend: one small state machine that wires the four screens together.
//
//   landing  --(sample / live / form)-->  route  --(open playbook)-->  playbook
//                                          |                              ^
//                                          +--(build my tour)-->  tour ---+
//
// Everything the server streams (/api/plan, /api/city) lands in `state`, which is persisted to
// localStorage so a judge can reload and pick up where they left off. Rendering is delegated to
// the sibling modules: trace.js (agent log), map.js (Leaflet), route.js (right rail),
// playbook.js (city cards), tour.js (itinerary + pitch), receipts.js (drawer of every Qloo call).
// Pin / drop / add re-route instantly in the browser with routing.js; no server round trip.

import { Trace } from "./trace.js";
import { createMap } from "./map.js";
import { renderRouteRail } from "./route.js";
import { renderPlaybook } from "./playbook.js";
import { renderTour } from "./tour.js";
import { Receipts } from "./receipts.js";
import { planRoute, compareObvious } from "./routing.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STORAGE_KEY = "nexttown.v1";

// Copied from data/scenarios/hollow-pines.json so the landing needs no extra fetch. The scenario id
// tells the server which recorded replay to stream; the request values are exactly what a judge
// would type for this (fictional) band.
const SCENARIO = {
  id: "hollow-pines",
  act: "Hollow Pines",
  fictional: true,
  blurb:
    "A fictional indie-folk trio from Richmond, VA, with a first record out and twelve days in April to tour it. Labeled fictional on purpose: the comps are real, the band is not.",
  request: {
    comps: ["Big Thief", "Waxahatchee", "Adrianne Lenker"],
    home: "Richmond, VA",
    days: 12,
    driveHoursCap: 6,
    format: "music",
  },
};

// How many /api/city streams run at once when "Build my tour" fills in the missing playbooks.
const CITY_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

function emptyState() {
  return {
    request: null, // PlanRequest (+ scenarioId / recorded)
    comps: [], // Comp[] once resolved
    localities: [], // Locality[] from rank_markets
    route: null, // Route
    obvious: null, // ObviousRoute
    playbooks: {}, // city label -> Playbook
    receipts: [], // every Receipt seen this session
    pinned: [], // locality labels forced into the loop
    dropped: [], // locality labels removed from the loop
    meta: null, // the stream's meta event (mode, model, recorded, fixtureNote)
    pitch: null, // Pitch from /api/pitch once the tour is built
    showObvious: false, // "Obvious route vs. your route" toggle
    closing: "", // the agent's closing narration (done.text)
  };
}

let state = emptyState();
let health = { ok: false, qloo: "demo", claude: false, recorded: false, model: "" };

// Long-lived UI objects.
let map = null;
let trace = null;
let receipts = null;
let drawerOpen = false;

// In-flight work.
let planAbort = null; // AbortController for the current /api/plan stream
let currentTurn = 0; // for grouping streamed narration under the right turn
let runOrigin = "sample"; // "sample" | "live" | "form": decides where a 503 is reported
const cityBuilds = new Map(); // city label -> Promise<Playbook>, so two clicks never start two streams

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function boot() {
  fillSampleCard();
  wireHeader();
  wireLanding();
  wireRouteScreen();
  wireOtherScreens();

  receipts = new Receipts($("receipts-drawer"), $("receipts-count"));

  const saved = loadState();
  if (saved?.route) $("resume-row").hidden = false;

  await fetchHealth();
  showScreen("landing");
}

function fillSampleCard() {
  $("sample-name").textContent = SCENARIO.act;
  $("sample-fictional").hidden = !SCENARIO.fictional;
  $("sample-blurb").textContent = SCENARIO.blurb;
  const r = SCENARIO.request;
  const facts = [
    ["Comps", r.comps.join(" · ")],
    ["Home", r.home],
    ["Days", String(r.days)],
    ["Drive cap", `${r.driveHoursCap} h / day`],
  ];
  $("sample-facts").innerHTML = facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("");
}

async function fetchHealth() {
  try {
    const res = await fetch("/api/health");
    if (res.ok) health = { ...health, ...(await res.json()) };
  } catch {
    /* offline or static preview: stay in the recorded defaults */
  }
  $("btn-live").hidden = !health.claude;
  $("form-note").textContent = health.claude
    ? "Custom routing runs the agent live against Qloo and Claude. Expect a minute or so of streaming."
    : "This server has no Anthropic key, so custom routing will be declined. The sample above works without one.";
  updateModePill();
}

// ---------------------------------------------------------------------------
// Header, mode pill, screens
// ---------------------------------------------------------------------------

function wireHeader() {
  $("brand").addEventListener("click", () => showScreen("landing"));
  $("nav-route").addEventListener("click", () => showScreen("route"));
  $("nav-tour").addEventListener("click", () => showTour());
  $("btn-start-over").addEventListener("click", startOver);

  $("receipts-toggle").addEventListener("click", () => setDrawer(!drawerOpen));
  $("drawer-scrim").addEventListener("click", () => setDrawer(false));

  // receipts.js opens and closes the drawer itself too (its close button, Escape, highlight()),
  // so watch its `is-open` class rather than tracking open state on our own.
  const drawer = $("receipts-drawer");
  new MutationObserver(() => syncDrawerChrome(drawer.classList.contains("is-open"))).observe(drawer, { attributes: true, attributeFilter: ["class"] });
}

// The drawer's content and slide-in are owned by receipts.js; we only ask it to open or close.
function setDrawer(open) {
  if (!receipts) return;
  if (open) receipts.open();
  else receipts.close();
  syncDrawerChrome(open);
}

// Scrim and header button state follow the drawer.
function syncDrawerChrome(open) {
  drawerOpen = open;
  $("drawer-scrim").hidden = !open;
  $("receipts-toggle").setAttribute("aria-expanded", String(open));
}

// Text per the contract: "Live: Qloo + Claude", "Recorded demo (pre-key placeholder)" or
// "Recorded demo (captured <date>)". The meta event is authoritative for a run; /api/health
// fills in before any run has started.
function modeLabel() {
  const m = state.meta;
  if (m) {
    if (m.recorded) return m.fixtureNote || "Recorded demo";
    return m.qlooMode === "live" ? "Live: Qloo + Claude" : "Live Claude · Qloo fixtures";
  }
  if (health.claude && health.qloo === "live") return "Live: Qloo + Claude";
  if (health.claude) return "Live Claude · Qloo fixtures";
  return "Recorded demo";
}

function updateModePill() {
  const pill = $("mode-pill");
  const label = modeLabel();
  pill.textContent = label;
  pill.classList.toggle("is-live", label.startsWith("Live"));
  pill.classList.toggle("is-recorded", !label.startsWith("Live"));
}

function showScreen(name) {
  document.querySelectorAll("[data-screen]").forEach((s) => s.classList.toggle("active", s.dataset.screen === name));
  const onLanding = name === "landing";
  $("crumbs").hidden = onLanding;
  $("btn-start-over").hidden = onLanding;
  if (name === "route") $("nav-route").setAttribute("aria-current", "page");
  else $("nav-route").removeAttribute("aria-current");
  if (name === "tour") $("nav-tour").setAttribute("aria-current", "page");
  else $("nav-tour").removeAttribute("aria-current");
  $("nav-tour").disabled = !tourReady();
  window.scrollTo({ top: 0 });
  // Leaflet needs a nudge when its container becomes visible.
  if (name === "route" && map) setTimeout(() => map.fitAll?.(), 50);
}

function tourReady() {
  return Boolean(state.pitch) || Boolean(state.route && state.route.stops.every((s) => state.playbooks[s.label]));
}

// ---------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------

function wireLanding() {
  $("btn-sample").addEventListener("click", () => startSample(true));
  $("btn-live").addEventListener("click", (e) => {
    e.preventDefault();
    startSample(false);
  });
  $("resume-link").addEventListener("click", resumeLast);
  $("btn-form-try-sample").addEventListener("click", () => startSample(true));
  $("act-form").addEventListener("submit", submitForm);
}

// Primary button: always the deterministic replay. "Run it live": same inputs, real agent.
function startSample(recorded) {
  runOrigin = recorded ? "sample" : "live";
  runPlan({ ...SCENARIO.request, scenarioId: SCENARIO.id, recorded });
}

function submitForm(e) {
  e.preventDefault();
  const errEl = $("form-error");
  errEl.hidden = true;
  $("btn-form-try-sample").hidden = true;

  const comps = ["comp-1", "comp-2", "comp-3"].map((id) => $(id).value.trim()).filter(Boolean);
  const home = $("home").value.trim();
  const days = Number($("days").value);
  const driveHoursCap = Number($("drive-cap").value);
  const format = $("format").value === "comedy" ? "comedy" : "music";

  const problems = [];
  $("comp-1").setAttribute("aria-invalid", String(comps.length === 0));
  $("home").setAttribute("aria-invalid", String(!home));
  if (comps.length === 0) problems.push("name at least one artist you sound like");
  if (!home) problems.push("add a home city like “Richmond, VA”");
  else if (!/,\s*[A-Za-z]{2}\s*$/.test(home)) problems.push("write the home city as “City, ST” so we can find it on the map");
  if (!(days >= 3 && days <= 21)) problems.push("days should be between 3 and 21");
  if (!(driveHoursCap >= 2 && driveHoursCap <= 10)) problems.push("the drive cap should be between 2 and 10 hours");
  if (problems.length) {
    errEl.textContent = "Almost: " + problems.join("; ") + ".";
    errEl.hidden = false;
    return;
  }

  runOrigin = "form";
  runPlan({ comps, home, days, driveHoursCap, format, recorded: false });
}

// ---------------------------------------------------------------------------
// Route screen: running /api/plan
// ---------------------------------------------------------------------------

function wireRouteScreen() {
  $("btn-skip").addEventListener("click", skipAhead);
  $("btn-stop").addEventListener("click", () => {
    planAbort?.abort();
    setRunning(false, "Stopped");
  });
  $("btn-build-tour").addEventListener("click", buildTour);
}

// Start (or restart) a planning run. `fast` replays the recorded scenario without the per-event delay.
async function runPlan(request, { fast = false } = {}) {
  planAbort?.abort();
  planAbort = new AbortController();

  // Fresh state for a fresh run; the previous one stays in localStorage until this one has a route.
  state = { ...emptyState(), request };
  currentTurn = 0;
  resetRouteScreen();
  showScreen("route");
  setRunning(true, fast ? "Replaying instantly…" : "Agent is working…");

  const url = "/api/plan" + (fast ? "?fast=1" : "");
  try {
    await postStream(url, request, planHandlers, { signal: planAbort.signal });
    if (!state.route) setRunning(false, "Finished without a route");
  } catch (err) {
    if (err?.name === "AbortError") return;
    setRunning(false, "Something went wrong");
    trace?.error(err.message);
    if (err.status === 503 && runOrigin === "form") {
      // Custom inputs need Claude; send the judge back to the form with the sample as a kind fallback.
      showScreen("landing");
      $("form-error").textContent = err.message;
      $("form-error").hidden = false;
      $("btn-form-try-sample").hidden = false;
      $("act-form").scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      toast(err.message, { error: true, actionLabel: "Try the sample", onAction: () => startSample(true) });
    }
  }
}

function resetRouteScreen() {
  trace = new Trace($("agent-log"));
  if (!map) map = createMap($("map"));
  map.setLocalities([]);
  map.setRoute(null);
  map.setHome(null);
  map.setObvious([], false);
  receipts.clear();
  setDrawer(false);
  $("agent-closing").hidden = true;
  $("agent-closing").innerHTML = "";
  $("btn-build-tour").disabled = true;
  $("btn-skip").hidden = true;
  $("build-progress").hidden = true;
  $("build-progress").innerHTML = "";
  $("route-title").textContent = "Planning your route";
  $("route-subtitle").textContent = describeRequest(state.request);
  renderRail();
  updateModePill();
}

function describeRequest(r) {
  if (!r) return "";
  return `${r.comps.join(" · ")} — from ${r.home} · ${r.days} days · ${r.driveHoursCap} h/day cap`;
}

function setRunning(on, label) {
  const el = $("run-status");
  el.textContent = label || "";
  el.classList.toggle("is-running", on);
  $("btn-stop").hidden = !on;
  if (!on) $("btn-skip").hidden = true;
}

// Each SSE event type from /api/plan maps to one small handler.
const planHandlers = {
  meta(m) {
    state.meta = m;
    updateModePill();
    trace.setMode(m.qlooMode, m.model);
    if (m.recorded) {
      $("btn-skip").hidden = false;
      trace.status("Replaying a recorded run of the agent. Skip ahead to see the finished route at once.");
    }
  },
  turn({ n }) {
    currentTurn = n;
    trace.startTurn(n);
  },
  thinking({ text }) {
    trace.thinking(text);
  },
  text({ delta }) {
    appendNarration(delta);
  },
  tool_call(ev) {
    trace.toolCall(ev);
  },
  tool_result(ev) {
    trace.toolResult(ev);
  },
  status({ message }) {
    trace.status(message);
  },
  comps({ comps }) {
    state.comps = comps;
    saveState();
  },
  receipt({ receipt }) {
    addReceipt(receipt);
  },
  markets({ localities }) {
    state.localities = localities;
    map.setLocalities(localities);
    $("route-title").textContent = "Ranking the markets";
    saveState();
  },
  route({ route, obvious }) {
    state.route = route;
    state.obvious = obvious;
    map.setRoute(route);
    $("route-title").textContent = "Your route";
    $("btn-build-tour").disabled = false;
    renderRail();
    saveState();
  },
  done({ text }) {
    state.closing = text || "";
    showClosing(state.closing);
    setRunning(false, state.route ? "Route ready" : "Done");
    $("nav-tour").disabled = !tourReady();
    saveState();
  },
  error({ message }) {
    trace.error(message);
    setRunning(false, "The agent hit an error");
    toast(message, { error: true });
  },
};

// Streamed narration goes into the agent log, grouped per turn (trace.js has no text method).
function appendNarration(delta) {
  const root = $("agent-log");
  let el = root.querySelector(`.trace-text[data-turn="${currentTurn}"]`);
  if (!el) {
    el = document.createElement("div");
    el.className = "trace-text";
    el.dataset.turn = String(currentTurn);
    root.appendChild(el);
  }
  el.textContent += delta;
  trace.scroll();
}

function showClosing(text) {
  const el = $("agent-closing");
  if (!text) {
    el.hidden = true;
    return;
  }
  el.innerHTML = `<span class="label">The agent's read</span>${esc(text)}`;
  el.hidden = false;
}

function skipAhead() {
  if (!state.request) return;
  runPlan(state.request, { fast: true });
}

function addReceipt(receipt) {
  state.receipts.push(receipt);
  receipts.add(receipt);
}

// ---------------------------------------------------------------------------
// Route rail: pin / drop / add re-route locally
// ---------------------------------------------------------------------------

function renderRail() {
  renderRouteRail($("route-rail"), {
    route: state.route,
    localities: state.localities,
    pinned: state.pinned,
    dropped: state.dropped,
    obvious: state.obvious,
    showObvious: state.showObvious,
    onPin,
    onDrop,
    onAdd,
    onOpenCity: (label) => openCity(label),
    onToggleObvious,
  });
}

function onPin(label, pin, { restore = false } = {}) {
  state.dropped = state.dropped.filter((l) => l !== label);
  if (restore) {
    // Restoring a dropped town just lets the planner consider it again.
  } else if (pin) {
    if (!state.pinned.includes(label)) state.pinned.push(label);
  } else {
    state.pinned = state.pinned.filter((l) => l !== label);
  }
  rerouteLocally();
}

function onDrop(label) {
  state.pinned = state.pinned.filter((l) => l !== label);
  if (!state.dropped.includes(label)) state.dropped.push(label);
  rerouteLocally();
}

// Adding a town from the picker pins it so the loop must include it.
function onAdd(label) {
  if (!label) return;
  onPin(label, true);
  map.focus(label);
}

function onToggleObvious(on) {
  state.showObvious = on;
  map.setObvious(state.obvious?.cities || [], on);
  renderRail();
  saveState();
}

// Same algorithm as src/routing.ts, run in the browser so edits feel instant.
function rerouteLocally() {
  if (!state.route || !state.request) return;
  try {
    const route = planRoute({
      home: state.route.home,
      localities: state.localities,
      days: state.request.days,
      driveHoursCap: state.request.driveHoursCap,
      mustInclude: state.pinned,
      exclude: state.dropped,
    });
    state.route = route;
    state.obvious = compareObvious(route, state.obvious?.cities || []);
    state.pitch = null; // the itinerary changed; the pitch must be rebuilt
    map.setRoute(route);
    renderRail();
    $("nav-tour").disabled = !tourReady();
    saveState();
  } catch (err) {
    toast(`Couldn't re-plan the loop: ${err.message}`, { error: true });
  }
}

// ---------------------------------------------------------------------------
// Playbooks: POST /api/city per stop
// ---------------------------------------------------------------------------

// Open a city's playbook, building it first if this session has not seen it yet.
async function openCity(label) {
  showScreen("playbook");
  $("playbook-title").textContent = `Playbook: ${label}`;
  $("playbook-pos").textContent = positionLabel(label);
  if (state.playbooks[label]) {
    $("playbook-status").hidden = true;
    renderPlaybookScreen(label);
    return;
  }
  const statusEl = $("playbook-status");
  statusEl.innerHTML = "";
  statusEl.hidden = false;
  $("playbook-view").innerHTML = `<div class="card placeholder-card">Asking Qloo about ${esc(label)}…</div>`;
  try {
    await buildPlaybook(label, { onStatus: (msg) => appendStatusLine(statusEl, msg) });
    statusEl.hidden = true;
    renderPlaybookScreen(label);
  } catch (err) {
    if (err?.name === "AbortError") return;
    statusEl.hidden = true;
    $("playbook-view").innerHTML = `<div class="card placeholder-card">Couldn't build this playbook: ${esc(err.message)}</div>`;
    toast(err.message, { error: true });
  }
}

function positionLabel(label) {
  const stops = state.route?.stops || [];
  const i = stops.findIndex((s) => s.label === label);
  return i >= 0 ? `Stop ${i + 1} of ${stops.length}` : "";
}

function renderPlaybookScreen(label) {
  const stops = state.route?.stops || [];
  const i = stops.findIndex((s) => s.label === label);
  const hasPrev = i > 0;
  const hasNext = i >= 0 && i < stops.length - 1;
  renderPlaybook($("playbook-view"), state.playbooks[label], {
    onShowQuery: showReceipt,
    onOpenReceipt: showReceipt,
    onPrev: hasPrev ? () => openCity(stops[i - 1].label) : null,
    onNext: hasNext ? () => openCity(stops[i + 1].label) : null,
    onPrint: () => window.print(),
    // Extras playbook.js understands: disables the arrows at the ends and labels the drive-in leg.
    hasPrev,
    hasNext,
    stop: i >= 0 ? stops[i] : null,
    prevLabel: i > 0 ? stops[i - 1].label : state.route?.home?.label,
  });
}

// "Show the query" on a card: open the drawer and highlight that receipt.
function showReceipt(receiptOrId) {
  const id = typeof receiptOrId === "string" ? receiptOrId : receiptOrId?.id;
  setDrawer(true);
  if (id) receipts.highlight(id);
}

// Stream one city's playbook. Deduplicated per label so "Build my tour" and a stop click can overlap.
function buildPlaybook(label, { onStatus } = {}) {
  if (state.playbooks[label]) return Promise.resolve(state.playbooks[label]);
  if (cityBuilds.has(label)) return cityBuilds.get(label);

  const locality = state.localities.find((l) => l.label === label);
  const body = {
    city: label,
    home: state.request.home,
    comps: state.comps,
    locality,
    scenarioId: state.request.scenarioId,
    // The sample replay stays deterministic end to end: its playbooks come from the recording too.
    // (A city the recording never saw falls through to a fresh build on the server.)
    recorded: replayingSample(),
  };
  const p = (async () => {
    let playbook = null;
    await postStream("/api/city", body, {
      status: ({ message }) => onStatus?.(message),
      receipt: ({ receipt }) => addReceipt(receipt),
      playbook: (ev) => {
        playbook = ev.playbook;
      },
      error: ({ message }) => {
        throw new Error(message);
      },
    });
    if (!playbook) throw new Error(`No playbook came back for ${label}.`);
    state.playbooks[label] = playbook;
    saveState();
    $("nav-tour").disabled = !tourReady();
    return playbook;
  })();
  cityBuilds.set(label, p);
  p.finally(() => cityBuilds.delete(label));
  return p;
}

function appendStatusLine(el, message) {
  el.querySelectorAll(".status-line").forEach((n) => n.classList.add("done"));
  const line = document.createElement("div");
  line.className = "status-line";
  line.textContent = message;
  el.appendChild(line);
}

// ---------------------------------------------------------------------------
// Tour: every playbook, then the pitch, then the printable itinerary
// ---------------------------------------------------------------------------

async function buildTour() {
  if (!state.route) return;
  const stops = state.route.stops;
  const btn = $("btn-build-tour");
  btn.disabled = true;

  // Progress chips: one per stop, plus the pitch.
  const progress = $("build-progress");
  progress.hidden = false;
  progress.innerHTML = "";
  const chips = new Map();
  for (const s of stops) chips.set(s.label, addChip(progress, s.label, state.playbooks[s.label] ? "done" : "queued"));
  const pitchChip = addChip(progress, "Booking pitch", "queued");

  let failures = 0;
  await mapLimit(stops, CITY_CONCURRENCY, async (s) => {
    const chip = chips.get(s.label);
    if (state.playbooks[s.label]) return;
    setChip(chip, "running");
    try {
      await buildPlaybook(s.label);
      setChip(chip, "done");
    } catch (err) {
      failures++;
      setChip(chip, "failed", err.message);
    }
  });

  setChip(pitchChip, "running");
  try {
    state.pitch = await fetchPitch();
    setChip(pitchChip, "done");
  } catch (err) {
    setChip(pitchChip, "failed", err.message);
    toast(`The pitch couldn't be written: ${err.message}. The itinerary is still here.`, { error: true });
  }
  saveState();
  btn.disabled = false;
  if (failures) toast(`${failures} stop${failures > 1 ? "s" : ""} couldn't be built; open them from the route to retry.`, { error: true });
  showTour();
}

async function fetchPitch() {
  const playbooks = (state.route?.stops || []).map((s) => state.playbooks[s.label]).filter(Boolean);
  const res = await fetch("/api/pitch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      route: state.route,
      playbooks,
      comps: state.comps,
      home: state.request.home,
      obvious: state.obvious,
      scenarioId: state.request.scenarioId,
      // The recorded pitch describes the recorded route, so only ask for it while the loop is untouched.
      recorded: replayingSample() && !state.pinned.length && !state.dropped.length,
    }),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  return res.json();
}

// True while this session is the sample's recorded replay (the primary landing button).
function replayingSample() {
  return Boolean(state.request?.scenarioId && state.request?.recorded === true);
}

function showTour() {
  if (!state.route) return;
  showScreen("tour");
  $("nav-tour").disabled = false;
  const built = (state.route.stops || []).filter((s) => state.playbooks[s.label]).length;
  $("tour-status").textContent = `${built} of ${state.route.stops.length} playbooks built`;
  renderTour($("tour-view"), {
    route: state.route,
    playbooks: state.playbooks,
    pitch: state.pitch,
    obvious: state.obvious,
    onOpenCity: (label) => openCity(label),
    onPrint: () => window.print(),
  });
}

function addChip(container, label, status) {
  const chip = document.createElement("span");
  chip.className = "progress-chip";
  chip.textContent = label;
  container.appendChild(chip);
  setChip(chip, status);
  return chip;
}

function setChip(chip, status, title) {
  chip.classList.remove("queued", "running", "done", "failed");
  chip.classList.add(status);
  chip.title = title || status;
}

function wireOtherScreens() {
  $("btn-back-route").addEventListener("click", () => showScreen("route"));
  $("btn-tour-back").addEventListener("click", () => showScreen("route"));
}

// ---------------------------------------------------------------------------
// Persistence: localStorage under nexttown.v1
// ---------------------------------------------------------------------------

function saveState() {
  if (!state.route && !state.localities.length) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), state }));
  } catch {
    /* private mode or quota: the session still works, it just won't resume */
  }
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.state && typeof parsed.state === "object" ? parsed.state : null;
  } catch {
    return null;
  }
}

// Rebuild the route screen from a saved session. The agent log is not saved, so it gets a note.
function resumeLast() {
  const saved = loadState();
  if (!saved?.route) {
    toast("Nothing saved yet. Try the sample first.");
    return;
  }
  planAbort?.abort();
  state = { ...emptyState(), ...saved };
  currentTurn = 0;
  resetRouteScreen();
  const note = document.createElement("div");
  note.className = "trace-note";
  note.textContent = "Restored from your last session. The live agent log isn't saved; run the sample again to watch it work.";
  $("agent-log").appendChild(note);
  map.setLocalities(state.localities);
  map.setRoute(state.route);
  map.setObvious(state.obvious?.cities || [], state.showObvious);
  for (const r of state.receipts) receipts.add(r);
  // trace.js counts Qloo calls from tool results, which a restore does not replay.
  document.querySelectorAll("[data-qloo-count]").forEach((n) => (n.textContent = String(state.receipts.length)));
  showClosing(state.closing);
  $("route-title").textContent = "Your route";
  $("btn-build-tour").disabled = false;
  renderRail();
  setRunning(false, "Restored");
  showScreen(state.pitch ? "tour" : "route");
  if (state.pitch) showTour();
}

function startOver() {
  if (!confirm("Start over? This clears the saved tour.")) return;
  planAbort?.abort();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
  state = emptyState();
  receipts.clear();
  setDrawer(false);
  $("resume-row").hidden = true;
  $("nav-tour").disabled = true;
  showScreen("landing");
}

// ---------------------------------------------------------------------------
// Streaming helper
// ---------------------------------------------------------------------------

// Reads a POST-initiated SSE stream and dispatches `handlers[event](payload)`. Same wire format as
// js/stream.js (which is pinned to a single endpoint); this takes the URL so /api/plan and /api/city
// can share it. Errors carry `status` so a 503 (live mode without a key) can be handled kindly.
async function postStream(url, body, handlers, { signal } = {}) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const err = new Error(await errorMessage(res));
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let type = "message";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event:")) type = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
        handlers[type]?.(payload); // a handler may throw (e.g. a server `error` event) to end the stream
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

async function errorMessage(res) {
  let message = `Request failed (${res.status})`;
  try {
    const j = await res.json();
    if (j?.error) message = j.error;
  } catch {
    /* not JSON */
  }
  if (res.status === 503 && !/key/i.test(message)) message += " Live mode needs an Anthropic key; try the sample.";
  return message;
}

// Run `fn` over `items` with at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift());
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

let toastTimer = null;
function toast(message, { error = false, actionLabel, onAction, ms = 6000 } = {}) {
  const el = $("toast");
  el.innerHTML = "";
  el.classList.toggle("is-error", error);
  el.append(document.createTextNode(message));
  if (actionLabel && onAction) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "link-btn";
    b.textContent = actionLabel;
    b.addEventListener("click", () => {
      el.hidden = true;
      onAction();
    });
    el.appendChild(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

boot();
