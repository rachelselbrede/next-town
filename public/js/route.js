// The right rail of the route screen: totals, the "Obvious route vs. your route" toggle, the ordered
// stops with pin / drop / open-playbook, the dropped list, and an "add a town" picker. Pure render:
// every click calls back into app.js, which re-routes locally (js/routing.js) and renders again.
//
// Contract: renderRouteRail(el, { route, localities, pinned, dropped, onPin, onDrop, onAdd, onOpenCity,
//                                 obvious, showObvious, onToggleObvious, addable? })
//   addable  optional Set of labels the "Add a town" picker may offer (demo mode: towns with recorded answers)
//
// Drive figures are estimates: straight-line miles x 1.25 road factor at 55 mph (see routing.js).

// The per-night framing shown beside the obvious-route comparison.
export const FRAMING_SENTENCE =
  "$600 guarantee against a $1,400 van, gas and hotel night: one empty Tuesday erases three good nights.";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtHours = (h) => (h >= 10 ? Math.round(h) : Math.round(h * 10) / 10) + " h";
const fmtPop = (p) => (typeof p === "number" ? (p >= 1_000_000 ? (p / 1_000_000).toFixed(1) + "M" : Math.round(p / 1000) + "k") : null);

export function renderRouteRail(el, opts) {
  const { route, localities = [], pinned = [], dropped = [], obvious, showObvious = false } = opts;
  el.innerHTML = "";

  if (!route || !route.stops?.length) {
    el.appendChild(h("div", { class: "card rail-empty" }, "Your stops will appear here once the agent has ranked the markets and planned the loop."));
    return;
  }

  el.appendChild(renderSummary(route));
  el.appendChild(h("p", { class: "rail-fine" }, "Drive times are straight-line estimates (x1.25 road factor at 55 mph)."));
  if (obvious) el.appendChild(renderObvious(obvious, showObvious, opts.onToggleObvious));
  el.appendChild(renderStops(route, pinned, opts));
  if (dropped.length) el.appendChild(renderDropped(dropped, opts.onPin));
  el.appendChild(renderAdd(route, localities, dropped, opts.onAdd, opts.addable));
  if (route.notes?.length) el.appendChild(renderNotes(route.notes));
}

// ---- pieces ----

function renderSummary(route) {
  const wrap = h("div", { class: "rail-summary", role: "group", "aria-label": "Route totals" });
  const stats = [
    [route.stops.length, "stops"],
    [Math.round(route.totalMiles).toLocaleString(), "miles"],
    [fmtHours(route.totalHours), "est. driving"],
    [route.driveDays, route.driveDays === 1 ? "drive day" : "drive days"],
  ];
  for (const [value, label] of stats) {
    wrap.appendChild(h("div", { class: "rail-stat" }, h("b", {}, String(value)), h("span", {}, label)));
  }
  return wrap;
}

function renderObvious(obvious, on, onToggle) {
  const card = h("div", { class: "card" });
  const toggle = h("div", { class: "obvious-toggle" });
  const sw = h(
    "button",
    { type: "button", class: "switch", role: "switch", "aria-checked": String(on), id: "obvious-switch" },
    h("span", { class: "switch-track", "aria-hidden": "true" }),
    h("span", {}, "Obvious route vs. your route"),
  );
  sw.addEventListener("click", () => onToggle?.(!on));
  toggle.appendChild(sw);
  card.appendChild(toggle);

  if (on) {
    const panel = h("div", { class: "obvious-panel" });
    panel.appendChild(h("p", { class: "obvious-summary" }, obvious.summary || ""));
    panel.appendChild(h("p", { class: "obvious-framing" }, FRAMING_SENTENCE));
    const overlap = new Set(obvious.overlap || []);
    const cities = h("div", { class: "obvious-cities", "aria-label": "Obvious route cities" });
    for (const city of obvious.cities || []) {
      cities.appendChild(h("span", { class: "chip" + (overlap.has(city) ? " is-overlap" : ""), title: overlap.has(city) ? "Also on your route" : "Not on your route" }, city));
    }
    panel.appendChild(cities);
    panel.appendChild(h("p", { class: "muted", style: "font-size:0.8rem;margin:8px 0 0" }, "Grey dots on the map mark these cities. Coral chips are the ones your route shares."));
    card.appendChild(panel);
  }
  return card;
}

function renderStops(route, pinned, { onPin, onDrop, onOpenCity, localities = [] }) {
  const byLabel = new Map(localities.map((l) => [l.label, l]));
  const section = h("div", {});
  section.appendChild(h("div", { class: "rail-section-title" }, h("span", {}, "Your stops"), h("span", { class: "muted", style: "font-size:0.8rem;font-family:var(--font-body);font-weight:700" }, `${route.days} days from ${route.home?.label ?? "home"}`)));
  const list = h("ol", { class: "stop-list", "aria-label": "Route stops in order" });
  const pinnedSet = new Set(pinned);
  let prevLabel = route.home?.label ?? "home";

  for (const stop of route.stops) {
    const isPinned = pinnedSet.has(stop.label);
    const li = h("li", { class: "stop" + (isPinned ? " is-pinned" : "") + (stop.driveDay ? " is-drive-day" : ""), "data-label": stop.label });

    li.appendChild(h("div", { class: "stop-day", "aria-label": `Day ${stop.day}` }, String(stop.day)));

    const main = h("div", { class: "stop-main" });
    const name = h("button", { type: "button", class: "stop-name", title: "Open the playbook for this town" }, stop.label);
    name.addEventListener("click", () => onOpenCity?.(stop.label, stop));
    main.appendChild(name);
    if (stop.overIndex) main.appendChild(h("span", { class: "badge-overindex", title: "Population under 250,000 and a national affinity rank of 20 or better" }, "over-index"));
    if (isPinned) main.appendChild(h("span", { class: "stop-pin-mark" }, "pinned"));
    li.appendChild(main);

    const meta = h("div", { class: "stop-meta" });
    meta.appendChild(h("span", { class: "leg" }, stop.legHours ? `${fmtHours(stop.legHours)} est. from ${prevLabel}` : "first stop"));
    if (stop.driveDay) meta.appendChild(h("span", { class: "drive-day" }, "drive day first"));
    if (typeof stop.rank === "number") meta.appendChild(h("span", { title: "National affinity rank for fans of your comps" }, `rank #${stop.rank}`));
    if (typeof stop.affinity === "number") meta.appendChild(h("span", {}, `${Math.round(stop.affinity * 100)}% affinity`));
    const pop = fmtPop(stop.population);
    if (pop) meta.appendChild(h("span", {}, `pop. ${pop}`));
    // Markets come from venues: the room that put this town on the list.
    const topRoom = stop.topRoom?.name || byLabel.get(stop.label)?.topRoom?.name;
    if (topRoom) meta.appendChild(h("span", { class: "top-room", title: "The room whose affinity ranked this town" }, `top room: ${topRoom}`));
    li.appendChild(meta);

    const actions = h("div", { class: "stop-actions" });
    const pinBtn = h("button", { type: "button", class: "btn btn-ghost" + (isPinned ? " is-on" : ""), "aria-pressed": String(isPinned) }, isPinned ? "Pinned" : "Pin");
    pinBtn.addEventListener("click", () => onPin?.(stop.label, !isPinned));
    const dropBtn = h("button", { type: "button", class: "btn btn-ghost" }, "Drop");
    dropBtn.addEventListener("click", () => onDrop?.(stop.label));
    const openBtn = h("button", { type: "button", class: "btn btn-secondary" }, "Open playbook");
    openBtn.addEventListener("click", () => onOpenCity?.(stop.label, stop));
    actions.append(pinBtn, dropBtn, openBtn);
    li.appendChild(actions);

    list.appendChild(li);
    prevLabel = stop.label;
  }
  section.appendChild(list);
  return section;
}

function renderDropped(dropped, onPin) {
  const section = h("div", {});
  section.appendChild(h("div", { class: "rail-section-title" }, h("span", {}, "Dropped")));
  const list = h("ul", { class: "dropped-list" });
  for (const label of dropped) {
    const li = h("li", { class: "dropped-item" }, h("span", {}, label));
    const restore = h("button", { type: "button", class: "btn btn-ghost btn-sm" }, "Restore");
    // Restoring = un-dropping. app.js clears it from `dropped`; passing pin=false keeps it unpinned.
    restore.addEventListener("click", () => onPin?.(label, false, { restore: true }));
    li.appendChild(restore);
    list.appendChild(li);
  }
  section.appendChild(list);
  return section;
}

function renderAdd(route, localities, dropped, onAdd, addable) {
  const inRoute = new Set(route.stops.map((s) => s.label));
  const droppedSet = new Set(dropped);
  const candidates = localities.filter((l) => typeof l.lat === "number" && !inRoute.has(l.label) && !droppedSet.has(l.label) && (!addable || addable.has(l.label)));
  const section = h("div", {});
  section.appendChild(h("div", { class: "rail-section-title" }, h("span", {}, "Add a town")));
  if (!candidates.length) {
    section.appendChild(h("p", { class: "rail-empty" }, addable ? "Every town with recorded Qloo answers is already on the route." : "Every ranked town is already on the route."));
    return section;
  }
  const row = h("div", { class: "add-row" });
  const select = h("select", { "aria-label": "Town to add", id: "add-town-select" });
  for (const l of candidates) {
    select.appendChild(h("option", { value: l.label }, `#${l.rank} ${l.label}${l.overIndex ? " · over-index" : ""}`));
  }
  const btn = h("button", { type: "button", class: "btn btn-secondary btn-sm" }, "Add");
  btn.addEventListener("click", () => onAdd?.(select.value));
  row.append(select, btn);
  section.appendChild(row);
  section.appendChild(h("p", { class: "muted", style: "font-size:0.8rem;margin:6px 0 0" }, addable ? "Adding pins the town; the loop re-plans around it. The demo lists only towns with recorded Qloo answers." : "Adding pins the town; the loop re-plans around it."));
  return section;
}

function renderNotes(notes) {
  const details = h("details", { class: "notes card" });
  details.appendChild(h("summary", {}, `Judgment calls the planner made (${notes.length})`));
  const ul = h("ul", {});
  for (const n of notes) ul.appendChild(h("li", {}, n));
  details.appendChild(ul);
  return details;
}

// Tiny element helper: h(tag, attrs, ...children) with text children escaped by the DOM itself.
function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

// Exported for playbook/tour modules that want the same badge markup.
export function overIndexBadgeHtml() {
  return `<span class="badge-overindex">over-index</span>`;
}
export { esc };
