// "Build my tour": the itinerary table, the booking-agent pitch, and a print-ready stack of
// advance sheets (one page per stop, see public/print.css).
//
// Contract: renderTour(el, { route, playbooks, pitch, obvious, onOpenCity, onPrint, fixtureNote? })
//   route        Route from the planner (stops carry day, legHours, driveDay, overIndex, population)
//   playbooks    either the app's map { "Asheville, NC": Playbook } or an array of Playbooks
//   pitch        Pitch | undefined (text, itinerary rows, totalMiles); the table still renders without it
//   obvious      ObviousRoute (usual-suspects comparison)
//   fixtureNote  the server's fixture note; "placeholder" puts the disclosure in every sheet footer
//
// Drive figures are straight-line estimates (x1.25 road factor at 55 mph); every label says "est.".
// Headings: the screen's <h1> is visually hidden, so the tour title is an <h2>, cards and sheets <h3>,
// blocks inside a sheet <h4>.
//
// Styles live in public/cards.css (screen) and public/print.css (print).

import { disclosureFor } from "./playbook.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pct = (a) => (typeof a === "number" && Number.isFinite(a) ? `${Math.round(a * 100)}%` : "");
const fmtInt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "");
const hours = (h) => (typeof h === "number" && Number.isFinite(h) ? (h === 0 ? "0" : h.toFixed(1)) : "");

const AGE_LABEL = {
  "24_and_younger": "24 and younger",
  "25_to_29": "25 to 29",
  "30_to_34": "30 to 34",
  "35_to_44": "35 to 44",
  "45_to_54": "45 to 54",
  "55_and_older": "55 and older",
};

export function renderTour(el, opts = {}) {
  if (!el) return;
  const route = opts.route;
  if (!route || !Array.isArray(route.stops) || !route.stops.length) {
    el.innerHTML = `<div class="tour-empty">Plan a route first, then build the tour.</div>`;
    return;
  }
  const books = toPlaybookMap(opts.playbooks);
  const pitch = opts.pitch || null;
  const obvious = opts.obvious || null;
  const rows = itineraryRows(route, books, pitch);
  const disclosure = disclosureFor(opts.fixtureNote);

  el.innerHTML = `
    <article class="tour">
      <nav class="tour-nav no-print" aria-label="Tour actions">
        <button type="button" class="pb-btn pb-btn-primary" data-action="print">Print advance sheets</button>
        <span class="pb-fine">Itinerary and pitch on page one, then one page per stop.</span>
      </nav>

      <header class="tour-head">
        <div class="pb-kicker">Tour sheet</div>
        <h2 class="pb-title">${esc(route.stops.length)} stops from ${esc(route.home?.label || "home")}</h2>
        <div class="pb-chips">
          <span class="pb-pill">${esc(fmtInt(Math.round(route.totalMiles || 0)))} miles <span class="pb-fine">est.</span></span>
          <span class="pb-pill" title="Straight-line estimate: miles x 1.25 road factor at 55 mph">${esc(hours(route.totalHours))} h est. driving</span>
          <span class="pb-pill">${esc(route.days)} days${route.driveDays ? `, ${esc(route.driveDays)} drive ${route.driveDays === 1 ? "day" : "days"}` : ""}</span>
          ${obvious ? `<span class="pb-badge-gold">${esc(obvious.smallTowns)} over-index ${obvious.smallTowns === 1 ? "town" : "towns"}</span>` : ""}
        </div>
        ${obvious?.summary ? `<p class="tour-obvious">${esc(obvious.summary)}</p>` : ""}
        <p class="pb-fine">Drive times are straight-line estimates (x1.25 road factor at 55 mph).</p>
      </header>

      <section class="tour-card">
        <h3 class="pb-card-title">Itinerary</h3>
        <div class="tour-table-wrap">
          <table class="tour-table">
            <thead>
              <tr><th scope="col">Day</th><th scope="col">City</th><th scope="col">Drive (est.)</th><th scope="col">Badge</th><th scope="col">Top room</th><th scope="col">Top promo</th><th scope="col">Age read</th></tr>
            </thead>
            <tbody>${rows.map(itineraryRow).join("")}</tbody>
          </table>
        </div>
        ${route.notes?.length ? `<details class="tour-notes no-print"><summary>Planner notes (${esc(route.notes.length)})</summary><ul>${route.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></details>` : ""}
      </section>

      <section class="tour-card tour-pitch">
        <h3 class="pb-card-title">Pitch for a booking agent</h3>
        ${pitch?.text ? `<p class="tour-pitch-text">${esc(pitch.text)}</p>` : `<p class="pb-none">The pitch is written once every stop has a playbook.</p>`}
        <p class="pb-caption">Numbers in the pitch are Qloo taste affinities for fans of your comps, not ticket counts.</p>
      </section>

      <section class="tour-sheets">
        <h3 class="pb-card-title no-print">Advance sheets <span class="pb-fine">one per stop; print to get a page each</span></h3>
        ${route.stops.map((s, i) => advanceSheet(s, i, route, books.get(keyOf(s.label)), disclosure)).join("")}
      </section>
    </article>`;

  el.querySelector('[data-action="print"]')?.addEventListener("click", () => (opts.onPrint ? opts.onPrint() : window.print()));
  el.querySelectorAll("[data-open-city]").forEach((b) =>
    b.addEventListener("click", () => opts.onOpenCity?.(b.dataset.openCity)),
  );
}

// ---------- itinerary ----------

// Accept the app's { label: Playbook } map or a Playbook[]; key by lower-cased label.
function toPlaybookMap(playbooks) {
  const m = new Map();
  if (!playbooks) return m;
  const list = Array.isArray(playbooks) ? playbooks : Object.values(playbooks);
  for (const pb of list) if (pb && pb.city) m.set(keyOf(pb.city), pb);
  return m;
}
const keyOf = (label) => String(label || "").trim().toLowerCase();

function itineraryRows(route, books, pitch) {
  const pitchRows = new Map((pitch?.itinerary || []).map((r) => [keyOf(r.city), r]));
  const rows = [];
  for (const s of route.stops) {
    const pb = books.get(keyOf(s.label));
    const pr = pitchRows.get(keyOf(s.label));
    if (s.driveDay) rows.push({ driveDay: true, day: s.day - 1, city: `Drive toward ${s.label}`, driveHours: s.legHours });
    rows.push({
      day: s.day,
      city: s.label,
      driveHours: s.legHours,
      overIndex: !!s.overIndex,
      usual: false,
      topRoom: pb?.rooms?.[0]?.name || pr?.topRoom || "",
      topPromo: topPromoOf(pb) || pr?.topPromo || "",
      ageRead: ageReadOf(pb?.who) || pr?.ageRead || "",
      hasPlaybook: !!pb,
    });
  }
  return rows;
}

function topPromoOf(pb) {
  const first = pb?.promo?.find((g) => g.places?.length);
  return first ? `${first.places[0].name} (${first.kind})` : "";
}

function ageReadOf(who) {
  if (!who?.strongestAge) return "";
  const v = who.age?.[who.strongestAge];
  return `${AGE_LABEL[who.strongestAge] || who.strongestAge}${typeof v === "number" ? ` (+${Math.round(v * 100)})` : ""}`;
}

function itineraryRow(r) {
  if (r.driveDay) {
    return `<tr class="tour-row-drive"><td class="pb-num">${esc(r.day)}</td><td colspan="6" class="pb-fine">${esc(r.city)}: ${esc(hours(r.driveHours))} h est., no show (over your drive cap)</td></tr>`;
  }
  const badge = r.overIndex ? `<span class="pb-badge-gold pb-badge-mini">over-index</span>` : "";
  const city = r.hasPlaybook
    ? `<button type="button" class="tour-city-link" data-open-city="${esc(r.city)}">${esc(r.city)}</button>`
    : esc(r.city);
  return `<tr>
    <td class="pb-num">${esc(r.day)}</td>
    <td class="tour-city">${city}</td>
    <td class="pb-num">${esc(hours(r.driveHours))} h est.</td>
    <td>${badge}</td>
    <td>${esc(r.topRoom) || `<span class="pb-fine">&mdash;</span>`}</td>
    <td>${esc(r.topPromo) || `<span class="pb-fine">&mdash;</span>`}</td>
    <td>${esc(r.ageRead) || `<span class="pb-fine">&mdash;</span>`}</td>
  </tr>`;
}

// ---------- advance sheets ----------

// One sheet per stop. Large type, the four cards condensed, nothing that needs a click.
function advanceSheet(stop, i, route, pb, disclosure = "") {
  const prev = i === 0 ? route.home?.label : route.stops[i - 1]?.label;
  const comps = (pb?.comps || []).map((c) => c.name).filter(Boolean).join(", ");
  const card = pb?.card || {};
  const rooms = (pb?.rooms || []).slice(0, 5);
  const promo = (pb?.promo || []).filter((g) => g.places?.length);
  const who = pb?.who || null;
  const brands = (pb?.localColor?.brands || []).slice(0, 4);
  const shows = (pb?.localColor?.shows || []).slice(0, 4);
  const promoCopy = Array.isArray(card.promo_copy) ? card.promo_copy.filter(Boolean).slice(0, 2) : [];
  const homeShort = String(pb?.home || route.home?.label || "home").split(",")[0];
  const homeOk = pb?.localColor?.homeAvailable !== false;

  return `
    <section class="advance-sheet" data-city="${esc(stop.label)}">
      <header class="sheet-head">
        <div class="sheet-day">Day ${esc(stop.day)}${stop.driveDay ? ` <span class="pb-fine">(drive day before)</span>` : ""}</div>
        <h3 class="sheet-title">${esc(stop.label)}</h3>
        <div class="pb-chips">
          ${typeof stop.rank === "number" ? `<span class="pb-pill pb-pill-forest">#${esc(stop.rank)} national affinity rank${typeof stop.affinity === "number" ? ` &middot; ${esc(pct(stop.affinity))}` : ""}</span>` : ""}
          ${typeof stop.population === "number" ? `<span class="pb-pill">Pop. ${esc(fmtInt(stop.population))} <span class="pb-fine">Census 2020</span></span>` : ""}
          ${stop.overIndex ? `<span class="pb-badge-gold">Over-index town</span>` : ""}
          ${pb?.locality?.topRoom?.name ? `<span class="pb-pill">Top room: ${esc(pb.locality.topRoom.name)}</span>` : ""}
          <span class="pb-pill">${esc(hours(stop.legHours))} h est. from ${esc(prev || "previous stop")}</span>
        </div>
        ${comps ? `<p class="pb-audience">Fans of ${esc(comps)} in this area</p>` : ""}
        ${card.summary ? `<p class="sheet-summary">${esc(card.summary)}</p>` : ""}
      </header>
      ${
        pb
          ? `
      <div class="sheet-grid">
        <section class="sheet-block">
          <h4>Rooms to call</h4>
          ${rooms.length ? `<ol>${rooms.map((r) => `<li><b>${esc(r.name)}</b>${typeof r.affinity === "number" ? ` <span class="pb-fine">${esc(pct(r.affinity))}</span>` : ""}${r.address ? `<br><span class="sheet-sub">${esc(r.address)}</span>` : ""}</li>`).join("")}</ol>` : `<p class="pb-none">No rooms returned.</p>`}
          <p class="sheet-fine">Confirm capacity and age policy with the room.</p>
        </section>
        <section class="sheet-block">
          <h4>Posters and partners</h4>
          ${promo.length ? `<ul>${promo.map((g) => `<li><b>${esc(capitalize(g.kind))}:</b> ${g.places.slice(0, 2).map((p) => esc(p.name)).join(", ")}</li>`).join("")}</ul>` : `<p class="pb-none">No partners returned.</p>`}
        </section>
        ${
          who
            ? `
        <section class="sheet-block">
          <h4>Who your comps draw</h4>
          <p>Strongest band: <b>${esc(AGE_LABEL[who.strongestAge] || who.strongestAge || "")}</b></p>
          ${who.suggestions?.length ? `<ul>${who.suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>` : ""}
          <p class="sheet-fine">Fans of your comps overall, not just this city. Suggestions from aggregate affinities, not facts about anyone.</p>
        </section>`
            : ""
        }
        <section class="sheet-block">
          <h4>${homeOk ? `Local color vs. ${esc(homeShort)}` : "Local color"}</h4>
          ${homeOk ? "" : `<p class="sheet-fine">Home comparison unavailable for this run.</p>`}
          ${brands.length ? `<p><b>Brands:</b> ${brands.map((d) => deltaInline(d, homeOk)).join(", ")}</p>` : ""}
          ${shows.length ? `<p><b>Shows:</b> ${shows.map((d) => deltaInline(d, homeOk)).join(", ")}</p>` : ""}
          ${promoCopy.length ? promoCopy.map((l) => `<p class="sheet-copy">&ldquo;${esc(l)}&rdquo;</p>`).join("") : ""}
          ${card.caution ? `<p class="sheet-fine">${esc(card.caution)}</p>` : ""}
        </section>
      </div>`
          : `<p class="pb-none">No playbook built for this stop yet. Open it from the route to fill this sheet.</p>`
      }
      <footer class="sheet-foot">
        <span>Next Town &middot; built from Qloo taste affinities for fans of your comps &middot; drive times are estimates</span>
        <span>${esc(stop.label)} &middot; day ${esc(stop.day)}</span>
        <span class="sheet-mode">${esc(disclosure)}</span>
      </footer>
    </section>`;
}

function deltaInline(d, homeOk = true) {
  if (!homeOk) return `${esc(d.name)} (${pct(d.cityAffinity)})`;
  if (typeof d.delta === "number") {
    const pts = Math.round(d.delta * 100);
    return `${esc(d.name)} (${pts > 0 ? "+" : ""}${esc(pts)})`;
  }
  return `${esc(d.name)} (new)`;
}

function capitalize(s) {
  const t = String(s || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
