// City playbook: the one-page view a band gets when they click a stop. Four cards, each
// built only from what Qloo returned (rooms, promo partners, demographics, local color),
// each with "Show the query" so judges can see the exact request behind it.
//
// Contract: renderPlaybook(el, playbook, { onShowQuery, onOpenReceipt, onPrev, onNext, onPrint })
// Optional extras the app may pass in the same options object:
//   stop         a RouteStop for this city (gives "x h est. drive from <previous stop>")
//   prevLabel    the previous stop's label (home city for the first stop)
//   hasPrev / hasNext  disable the arrow buttons at the ends of the route
//   fixtureNote  the server's fixture note; when it says "placeholder" the footer carries the disclosure
//
// Headings: the screen's own <h1> is visually hidden, so the city name is an <h2>, cards are <h3>,
// groups inside a card are <h4>.
//
// Styles live in public/cards.css (screen) and public/print.css (print).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pct = (a) => (typeof a === "number" && Number.isFinite(a) ? `${Math.round(a * 100)}%` : "");
const fmtInt = (n) => (typeof n === "number" && Number.isFinite(n) ? n.toLocaleString("en-US") : "");

// One suggested ask per promo kind. Plain, specific, and small enough that a shop owner says yes.
const PROMO_ASK = {
  "record store": "Ask: a poster by the register, a stack of handbills, and five LPs on consignment for show week.",
  "coffee shop": "Ask: a poster in the window and a flyer on the community board; offer two tickets for the staff.",
  bookstore: "Ask: a poster on the events board. Bookstores host readings and know the listening crowd in town.",
  "dive bar": "Ask: a poster behind the bar and a day-of mention. Suggest it as the pre-show meetup spot.",
  "vintage shop": "Ask: a poster in the window or fitting room. Their regulars are the people who come out to shows.",
};
const PROMO_ASK_DEFAULT = "Ask: a poster in the window and a flyer by the register, two weeks out.";

// Shown verbatim while the Qloo answers are hand-written placeholders (fixture note contains "placeholder").
export const PLACEHOLDER_DISCLOSURE =
  "Until our Qloo API key arrives, the Qloo answers in this demo are hand-written placeholders in Qloo's documented response shape. Place names are real; every score, rating and affinity is invented.";

// "" for live answers; the disclosure for placeholders; a dated line for captured data.
export function disclosureFor(note) {
  if (!note) return "";
  if (/placeholder/i.test(note)) return PLACEHOLDER_DISCLOSURE;
  const m = /captured\s+(\d{4}-\d{2}-\d{2})/i.exec(note);
  return m ? `Qloo data captured ${m[1]}.` : "";
}

// Human labels for Qloo demographic bands.
const AGE_LABEL = {
  "24_and_younger": "24 and younger",
  "25_to_29": "25 to 29",
  "30_to_34": "30 to 34",
  "35_to_44": "35 to 44",
  "45_to_54": "45 to 54",
  "55_and_older": "55 and older",
};
const AGE_ORDER = Object.keys(AGE_LABEL);

export function renderPlaybook(el, playbook, opts = {}) {
  if (!el) return;
  if (!playbook) {
    el.innerHTML = `<div class="pb-empty">Pick a stop on the route to build its playbook.</div>`;
    return;
  }
  const p = playbook;
  const comps = Array.isArray(p.comps) ? p.comps : [];
  const receipts = Array.isArray(p.receipts) ? p.receipts : [];
  const card = p.card || {};

  el.innerHTML = `
    <article class="playbook" data-city="${esc(p.city)}">
      ${renderNav(opts)}
      ${renderHeader(p, comps, card, opts)}
      ${
        p.noDemoData
          ? renderNoDemoData(p, receipts)
          : `<div class="pb-grid">
        ${renderRooms(p.rooms, card, receipts)}
        ${renderPromo(p.promo, card, receipts)}
        ${renderWho(p.who, card, receipts)}
        ${renderLocalColor(p.localColor, p.city, p.home, card, receipts)}
      </div>`
      }
      <footer class="pb-foot">
        <span class="pb-fine">${esc(receipts.length)} Qloo ${receipts.length === 1 ? "call" : "calls"} behind this page. Everything here is an aggregate taste affinity for fans of your comps, not a fact about any person.</span>
        ${disclosureFor(opts.fixtureNote) ? `<span class="pb-fine pb-disclosure">${esc(disclosureFor(opts.fixtureNote))}</span>` : ""}
      </footer>
    </article>`;

  wireButtons(el, p, receipts, opts);
}

// ---------- sections ----------

// Demo mode only: the recorded Qloo answers cover the sample's cities, and this one is not among
// them. Say so plainly instead of rendering four empty cards that read like "Qloo found nothing".
function renderNoDemoData(p, receipts) {
  const first = receipts[0];
  return `
    <section class="pb-card pb-nodata" aria-label="No recorded data for this city">
      <h3 class="pb-card-title">No recorded Qloo answers for ${esc(p.city)} in this demo</h3>
      <p>The demo carries real-shaped Qloo responses for the cities on the Hollow Pines sample route. ${esc(p.city)} came into the loop when you edited it, so there is nothing recorded to show.</p>
      <p>With a Qloo key, the same ${esc(receipts.length)} queries run live for any US city: rooms, promo partners, who shows up, and local color against ${esc(p.home || "home")}.</p>
      ${first ? `<button type="button" class="pb-query no-print" data-action="query" data-tool="${esc(first.tool)}" data-receipt="${esc(first.id)}">Show the queries</button>` : ""}
    </section>`;
}

function renderNav(opts) {
  const prevDis = opts.hasPrev === false ? "disabled" : "";
  const nextDis = opts.hasNext === false ? "disabled" : "";
  return `
    <nav class="pb-nav no-print" aria-label="Playbook navigation">
      <button type="button" class="pb-btn" data-action="prev" ${prevDis}>&larr; Previous stop</button>
      <button type="button" class="pb-btn" data-action="next" ${nextDis}>Next stop &rarr;</button>
      <span class="pb-nav-spacer"></span>
      <button type="button" class="pb-btn pb-btn-primary" data-action="print">Print this page</button>
    </nav>`;
}

function renderHeader(p, comps, card, opts) {
  const loc = p.locality || {};
  const stop = opts.stop || p.stop || null;
  const chips = [];
  if (typeof loc.rank === "number") chips.push(`<span class="pb-pill pb-pill-forest" title="National rank among US markets for fans of your comps: the town whose best-matching room ranks highest">#${esc(loc.rank)} national affinity rank${typeof loc.affinity === "number" ? ` &middot; ${esc(pct(loc.affinity))}` : ""}</span>`);
  if (typeof loc.population === "number") chips.push(`<span class="pb-pill">Pop. ${esc(fmtInt(loc.population))} <span class="pb-fine">Census 2020</span></span>`);
  if (loc.overIndex) chips.push(`<span class="pb-badge-gold" title="Population under 250,000 and a national affinity rank of 20 or better (not a comparison with home)">Over-index town</span>`);
  if (loc.topRoom?.name) chips.push(`<span class="pb-pill" title="The room whose affinity ranked this town">Top room: ${esc(loc.topRoom.name)}</span>`);
  if (stop && typeof stop.legHours === "number" && stop.legHours > 0) {
    const from = opts.prevLabel || p.prevLabel;
    chips.push(`<span class="pb-pill" title="Straight-line estimate: miles x 1.25 road factor at 55 mph">${esc(stop.legHours.toFixed(1))} h est. drive${from ? ` from ${esc(from)}` : " from the previous stop"}${stop.driveDay ? " (drive day first)" : ""}</span>`);
  }
  if (stop && typeof stop.day === "number") chips.push(`<span class="pb-pill">Day ${esc(stop.day)}</span>`);

  const compNames = comps.map((c) => c.name).filter(Boolean);
  const audience = compNames.length ? `Fans of ${esc(compNames.join(", "))} in this area` : "Fans of your comps in this area";

  return `
    <header class="pb-head">
      <div class="pb-kicker">City playbook</div>
      <h2 class="pb-title">${esc(p.city)}</h2>
      <div class="pb-chips">${chips.join("")}</div>
      <p class="pb-audience">${audience}</p>
      ${card.summary ? `<p class="pb-summary">${esc(card.summary)}</p>` : ""}
    </header>`;
}

function renderRooms(rooms, card, receipts) {
  const list = (Array.isArray(rooms) ? rooms : []).slice(0, 8);
  const body = list.length
    ? `<ol class="pb-list pb-rooms">${list.map(renderRoom).join("")}</ol>`
    : `<p class="pb-none">Qloo returned no rooms for this query. Widen the radius or check the tag ids.</p>`;
  return cardShell({
    id: "rooms",
    title: "Rooms your fans like",
    tool: "find_rooms",
    receipts,
    note: card.rooms_note,
    body,
    caption: "Qloo doesn't know capacity or age policy; confirm with the room.",
  });
}

function renderRoom(r) {
  const meta = [];
  if (typeof r.rating === "number") meta.push(`<span class="pb-rating" title="Business rating">&#9733; ${esc(r.rating.toFixed(1))}</span>`);
  if (typeof r.price_level === "number" && r.price_level > 0) meta.push(`<span class="pb-price" aria-label="price level ${esc(r.price_level)} of 4">${"$".repeat(Math.min(4, r.price_level))}</span>`);
  return `
    <li class="pb-item">
      <div class="pb-item-head">
        <span class="pb-item-name">${esc(r.name)}</span>
        <span class="pb-item-meta">${meta.join(" ")}</span>
      </div>
      ${r.address ? `<div class="pb-item-sub">${esc(r.address)}</div>` : ""}
      ${affinityBar(r.affinity)}
      ${whyChips(r.why)}
    </li>`;
}

function renderPromo(promo, card, receipts) {
  const groups = Array.isArray(promo) ? promo : [];
  const body = groups.length
    ? groups
        .map((g) => {
          const places = (Array.isArray(g.places) ? g.places : []).slice(0, 2);
          if (!places.length) return "";
          const kind = String(g.kind || "");
          return `
            <section class="pb-group">
              <h4 class="pb-group-title">${esc(capitalize(kind))}${places.length > 1 ? "s" : ""}</h4>
              <ul class="pb-list">${places
                .map(
                  (pl) => `
                <li class="pb-item pb-item-compact">
                  <div class="pb-item-head"><span class="pb-item-name">${esc(pl.name)}</span>${typeof pl.rating === "number" ? `<span class="pb-item-meta"><span class="pb-rating">&#9733; ${esc(pl.rating.toFixed(1))}</span></span>` : ""}</div>
                  ${pl.address ? `<div class="pb-item-sub">${esc(pl.address)}</div>` : ""}
                  ${whyChips(pl.why)}
                </li>`,
                )
                .join("")}</ul>
              <p class="pb-ask">${esc(PROMO_ASK[kind] || PROMO_ASK_DEFAULT)}</p>
            </section>`;
        })
        .join("")
    : `<p class="pb-none">Qloo returned no promo partners for this query.</p>`;
  return cardShell({
    id: "promo",
    title: "Where to hang posters",
    tool: "find_promo_partners",
    receipts,
    note: card.promo_note,
    body,
    caption: "One Qloo call per kind of place, near this city. Pick the two you'd actually walk into.",
  });
}

function renderWho(who, card, receipts) {
  // Hidden entirely when Qloo had no demographics for this market (the contract says so).
  if (!who || typeof who !== "object") return "";
  const age = who.age || {};
  const gender = who.gender || {};
  const bands = AGE_ORDER.filter((k) => k in age).concat(Object.keys(age).filter((k) => !AGE_ORDER.includes(k)));
  const ageRows = bands.map((k) => divergingBar(AGE_LABEL[k] || k.replace(/_/g, " "), age[k], k === who.strongestAge)).join("");
  const genderRows = Object.keys(gender)
    .map((k) => divergingBar(capitalize(k), gender[k], false))
    .join("");
  const suggestions = Array.isArray(who.suggestions) ? who.suggestions.filter(Boolean) : [];
  const body = `
    <p class="pb-scope">Qloo's demographics read is for fans of your comps overall, not just this city.</p>
    <div class="pb-demo">
      <div class="pb-demo-col">
        <h4 class="pb-group-title">Age bands <span class="pb-fine">affinity vs. baseline</span></h4>
        <div class="pb-bars">${ageRows || `<p class="pb-none">No age bands returned.</p>`}</div>
      </div>
      <div class="pb-demo-col">
        <h4 class="pb-group-title">Gender <span class="pb-fine">affinity vs. baseline</span></h4>
        <div class="pb-bars">${genderRows || `<p class="pb-none">No gender bands returned.</p>`}</div>
      </div>
    </div>
    ${
      suggestions.length
        ? `<div class="pb-suggest"><div class="pb-suggest-label">Suggestions, not facts</div><ul>${suggestions.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
        : ""
    }`;
  return cardShell({
    id: "who",
    title: "Who your comps draw",
    tool: "who_shows_up",
    receipts,
    note: card.who_note,
    body,
    caption: "Age and gender are affinities for fans of your comps everywhere, averaged across comps. Positive means over-represented versus Qloo's baseline. Qloo's demographics query takes no location, so this is not a read on this town.",
  });
}

function renderLocalColor(localColor, city, home, card, receipts) {
  const lc = localColor || {};
  const brands = Array.isArray(lc.brands) ? lc.brands : [];
  const shows = Array.isArray(lc.shows) ? lc.shows : [];
  const cityShort = String(city || "").split(",")[0];
  const homeShort = String(home || "").split(",")[0];
  // homeAvailable === false: the home-city calls failed, so there is nothing to compare against.
  // Show this city's list on its own and say so; never "not in the home top list".
  const homeOk = lc.homeAvailable !== false;
  const table = (rows, label) =>
    rows.length
      ? `
      <h4 class="pb-group-title">${esc(label)}</h4>
      <table class="pb-delta">
        <thead><tr><th scope="col">${esc(label)}</th><th scope="col">${esc(cityShort)}</th>${homeOk ? `<th scope="col">${esc(homeShort)}</th><th scope="col">Delta</th>` : ""}</tr></thead>
        <tbody>${rows.map((d) => deltaRow(d, homeOk)).join("")}</tbody>
      </table>`
      : `<h4 class="pb-group-title">${esc(label)}</h4><p class="pb-none">Nothing returned.</p>`;
  const promoCopy = Array.isArray(card.promo_copy) ? card.promo_copy.filter(Boolean).slice(0, 2) : [];
  const body = `
    ${homeOk ? "" : `<p class="pb-scope">Home comparison unavailable for this run: the ${esc(homeShort || "home")} calls did not come back, so these are this city's affinities on their own.</p>`}
    <div class="pb-color">
      <div class="pb-color-col">${table(brands, "Brands")}</div>
      <div class="pb-color-col">${table(shows, "TV shows")}</div>
    </div>
    ${promoCopy.length ? `<div class="pb-copy"><div class="pb-suggest-label">Promo copy to try</div>${promoCopy.map((l) => `<p class="pb-copy-line">&ldquo;${esc(l)}&rdquo;</p>`).join("")}</div>` : ""}
    ${card.caution ? `<p class="pb-caution">${esc(card.caution)}</p>` : ""}`;
  return cardShell({
    id: "color",
    title: homeOk ? `Local color: what this crowd loves that ${esc(homeShort || "home")} doesn't` : "Local color: what this crowd loves",
    titleIsHtml: true,
    tool: "local_color",
    receipts,
    note: card.local_color_note,
    body,
  });
}

function deltaRow(d, homeOk = true) {
  const cityV = pct(d.cityAffinity);
  if (!homeOk) return `<tr><td class="pb-delta-name">${esc(d.name)}</td><td class="pb-num">${esc(cityV)}</td></tr>`;
  const hasHome = typeof d.homeAffinity === "number";
  const homeV = hasHome ? pct(d.homeAffinity) : `<span class="pb-fine">not in home top 20</span>`;
  let delta = "";
  if (typeof d.delta === "number") {
    const pts = Math.round(d.delta * 100);
    const cls = pts > 0 ? "up" : pts < 0 ? "down" : "flat";
    const arrow = pts > 0 ? "&#9650;" : pts < 0 ? "&#9660;" : "&bull;";
    delta = `<span class="pb-arrow pb-arrow-${cls}">${arrow} ${pts > 0 ? "+" : ""}${esc(pts)}</span>`;
  } else {
    delta = `<span class="pb-arrow pb-arrow-new" title="Only in this city's top list">new</span>`;
  }
  return `<tr><td class="pb-delta-name">${esc(d.name)}</td><td class="pb-num">${esc(cityV)}</td><td class="pb-num">${hasHome ? esc(homeV) : homeV}</td><td class="pb-num">${delta}</td></tr>`;
}

// ---------- small pieces ----------

// Every card gets the same frame: title, optional Claude note, body, optional caption, and "Show the query".
function cardShell({ id, title, titleIsHtml, tool, receipts, note, body, caption }) {
  const rs = receipts.filter((r) => r.tool === tool);
  const receiptId = rs[0]?.id;
  const count = rs.length;
  return `
    <section class="pb-card" data-card="${esc(id)}" data-tool="${esc(tool)}">
      <div class="pb-card-head">
        <h3 class="pb-card-title">${titleIsHtml ? title : esc(title)}</h3>
        <button type="button" class="pb-query no-print" data-action="query" data-tool="${esc(tool)}" ${receiptId ? `data-receipt="${esc(receiptId)}"` : ""} title="Open the Receipts drawer at this request">
          Show the query${count > 1 ? ` (${esc(count)})` : ""}
        </button>
      </div>
      ${note ? `<p class="pb-note">${esc(note)}</p>` : ""}
      <div class="pb-card-body">${body}</div>
      ${caption ? `<p class="pb-caption">${esc(caption)}</p>` : ""}
    </section>`;
}

function affinityBar(a) {
  if (typeof a !== "number" || !Number.isFinite(a)) return "";
  const w = Math.max(0, Math.min(100, Math.round(a * 100)));
  return `<div class="pb-aff" title="Affinity for fans of your comps: ${esc(w)}%"><span class="pb-aff-fill" style="width:${esc(w)}%"></span><span class="pb-aff-num">${esc(w)}%</span></div>`;
}

// Rec.why entries look like "Big Thief (71%)". Render them as "because Big Thief 71% / Waxahatchee 58%" chips.
function whyChips(why) {
  const list = Array.isArray(why) ? why.filter(Boolean) : [];
  if (!list.length) return "";
  const chips = list.map((w) => {
    const m = /^(.*?)\s*\((\d+)%\)\s*$/.exec(String(w));
    return m ? `<span class="pb-chip">${esc(m[1])} <b>${esc(m[2])}%</b></span>` : `<span class="pb-chip">${esc(w)}</span>`;
  });
  return `<div class="pb-why"><span class="pb-why-label">because</span>${chips.join(`<span class="pb-why-sep">/</span>`)}</div>`;
}

// A bar that grows right for positive affinity and left for negative, from a center line.
function divergingBar(label, value, strongest) {
  const v = typeof value === "number" && Number.isFinite(value) ? value : 0;
  const w = Math.min(50, Math.round(Math.abs(v) * 50));
  const side = v >= 0 ? "pos" : "neg";
  const pts = Math.round(v * 100);
  return `
    <div class="pb-bar ${strongest ? "pb-bar-strong" : ""}">
      <span class="pb-bar-label">${esc(label)}${strongest ? ` <span class="pb-badge-gold pb-badge-mini">strongest</span>` : ""}</span>
      <span class="pb-bar-track"><span class="pb-bar-fill pb-bar-${side}" style="width:${esc(w)}%"></span></span>
      <span class="pb-bar-num">${pts > 0 ? "+" : ""}${esc(pts)}</span>
    </div>`;
}

function capitalize(s) {
  const t = String(s || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ---------- events ----------

function wireButtons(el, playbook, receipts, opts) {
  el.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "prev") opts.onPrev?.(playbook);
      else if (action === "next") opts.onNext?.(playbook);
      else if (action === "print") (opts.onPrint ? opts.onPrint(playbook) : window.print());
      else if (action === "query") {
        const id = btn.dataset.receipt || btn.dataset.tool;
        const receipt = receipts.find((r) => r.id === btn.dataset.receipt);
        if (opts.onShowQuery) opts.onShowQuery(id, receipt);
        else if (opts.onOpenReceipt) opts.onOpenReceipt(receipt || id);
      }
    });
  });
}
