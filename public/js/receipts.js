// The Receipts drawer: every Qloo call the app made, in order, with the exact URL. Judges can
// read the parameters, copy a curl line, and jump to the call behind any card ("Show the query").
//
// Contract: class Receipts { constructor(drawerEl, countEl); add(receipt); clear(); open(); close(); toggle(); highlight(id) }
//   Receipt = { id, tool, method, url, mode, status, ms, resultCount, top: [{ name, affinity }], note?, resolved?, cached? }
//
// The drawer slides in from the right (class "is-open" on drawerEl; styles in public/cards.css).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const pct = (a) => (typeof a === "number" && Number.isFinite(a) ? `${Math.round(a * 100)}%` : "");

// Plain-English names for the tool behind each call.
const TOOL_LABEL = {
  resolve_act: "Resolve act",
  rank_markets: "Rank markets",
  find_rooms: "Find rooms",
  find_promo_partners: "Promo partners",
  find_promo_group: "Promo partners",
  who_shows_up: "Who shows up",
  local_color: "Local color",
  openers_to_ask: "Openers to ask",
  find_tags: "Find tags",
};

export class Receipts {
  constructor(drawerEl, countEl) {
    this.drawer = drawerEl;
    this.countEl = countEl;
    this.items = new Map(); // id -> { receipt, el }
    this.isOpen = false;
    this.drawer.classList.add("receipts");
    this.drawer.setAttribute("role", "complementary");
    this.drawer.setAttribute("aria-label", "Receipts: every Qloo call");
    this.drawer.setAttribute("aria-hidden", "true");
    this.drawer.innerHTML = `
      <div class="receipts-head">
        <div>
          <div class="pb-kicker">Receipts</div>
          <div class="receipts-sub">Every Qloo call, in order. Key never shown.</div>
        </div>
        <button type="button" class="pb-btn receipts-close" data-action="close" aria-label="Close receipts">Close</button>
      </div>
      <ol class="receipts-list" aria-live="polite"></ol>
      <div class="receipts-empty">No Qloo calls yet.</div>`;
    this.list = this.drawer.querySelector(".receipts-list");
    this.empty = this.drawer.querySelector(".receipts-empty");
    this.sub = this.drawer.querySelector(".receipts-sub");
    this.drawer.querySelector('[data-action="close"]').addEventListener("click", () => this.close());
    this.list.addEventListener("click", (e) => this.onClick(e));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && this.isOpen) this.close();
    });
    this.updateCount();
  }

  // Append a receipt (chronological). A receipt with an id we already hold is updated in place,
  // which is what happens when the playbook event repeats the receipts already streamed.
  add(receipt) {
    if (!receipt || !receipt.id) return;
    const existing = this.items.get(receipt.id);
    const el = renderEntry(receipt, this.items.size + 1);
    if (existing) {
      el.querySelector(".receipt-n").textContent = existing.el.querySelector(".receipt-n").textContent;
      existing.el.replaceWith(el);
      this.items.set(receipt.id, { receipt, el });
    } else {
      this.list.appendChild(el);
      this.items.set(receipt.id, { receipt, el });
    }
    this.updateCount();
  }

  // The subtitle says where these answers came from (app.js sets it from the server's fixture note).
  setNote(text) {
    if (this.sub) this.sub.textContent = text || "Every Qloo call, in order. Key never shown.";
  }

  clear() {
    this.items.clear();
    this.list.innerHTML = "";
    this.updateCount();
  }

  open() {
    this.isOpen = true;
    this.drawer.classList.add("is-open");
    this.drawer.setAttribute("aria-hidden", "false");
  }

  close() {
    this.isOpen = false;
    this.drawer.classList.remove("is-open");
    this.drawer.setAttribute("aria-hidden", "true");
  }

  toggle() {
    this.isOpen ? this.close() : this.open();
  }

  // Open the drawer, scroll to the entry, expand it, and flash it. Accepts a receipt id or a tool
  // name (then the most recent call for that tool is used).
  highlight(id) {
    this.open();
    let item = this.items.get(id);
    if (!item) {
      for (const it of this.items.values()) if (it.receipt.tool === id) item = it; // last one wins
    }
    if (!item) return false;
    const el = item.el;
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.classList.remove("flash");
    void el.offsetWidth; // restart the animation if it was already flashing
    el.classList.add("flash");
    setTimeout(() => el.classList.remove("flash"), 1600);
    return true;
  }

  get(id) {
    return this.items.get(id)?.receipt;
  }

  updateCount() {
    const n = this.items.size;
    if (this.countEl) {
      this.countEl.textContent = String(n);
      this.countEl.setAttribute("aria-label", `${n} Qloo ${n === 1 ? "call" : "calls"}`);
    }
    this.empty.hidden = n > 0;
  }

  onClick(e) {
    const btn = e.target.closest("[data-copy]");
    if (!btn) return;
    const entry = btn.closest(".receipt");
    const item = this.items.get(entry?.dataset.id);
    if (!item) return;
    const text = btn.dataset.copy === "curl" ? curlFor(item.receipt) : item.receipt.url;
    copyText(text).then(
      () => flashLabel(btn, "Copied"),
      () => flashLabel(btn, "Copy failed"),
    );
  }
}

// ---------- rendering ----------

function renderEntry(r, n) {
  const el = document.createElement("details");
  el.className = `receipt ${r.status >= 200 && r.status < 300 ? "ok" : "fail"}`;
  el.dataset.id = r.id;
  const { path, params } = parseUrl(r.url);
  const context = contextOf(params);
  const top = Array.isArray(r.top) ? r.top.slice(0, 3) : [];
  el.innerHTML = `
    <summary>
      <span class="receipt-n">${esc(n)}</span>
      <span class="receipt-tool">${esc(TOOL_LABEL[r.tool] || r.tool)}${context ? ` <span class="receipt-context">${esc(context)}</span>` : ""}</span>
      <span class="receipt-path"><span class="receipt-method">${esc(r.method || "GET")}</span> ${esc(path)}</span>
      <span class="receipt-meta">
        <span class="pb-pill pb-pill-mini ${r.mode === "live" ? "pb-pill-live" : ""}">${esc(r.mode)}</span>
        ${r.cached ? `<span class="pb-pill pb-pill-mini" title="Served from this server's private in-memory cache of a live answer">cached</span>` : ""}
        <span class="receipt-status">HTTP ${esc(r.status)}</span>
        <span class="receipt-ms">${esc(r.ms)} ms</span>
        <span class="receipt-count">${esc(r.resultCount)} ${r.resultCount === 1 ? "result" : "results"}</span>
      </span>
    </summary>
    <div class="receipt-body">
      <table class="receipt-params">
        <caption>Parameters</caption>
        <tbody>${params.length ? params.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("") : `<tr><td class="pb-fine">none</td></tr>`}</tbody>
      </table>
      ${
        top.length
          ? `<div class="receipt-top"><div class="pb-suggest-label">Top ${esc(top.length)}</div><ol>${top.map((t) => `<li>${esc(t.name)}${typeof t.affinity === "number" ? ` <span class="pb-fine">${esc(pct(t.affinity))}</span>` : ""}</li>`).join("")}</ol></div>`
          : ""
      }
      ${r.resolved ? `<p class="receipt-resolved pb-fine">Qloo matched the location to <b>${esc(r.resolved)}</b>.</p>` : ""}
      ${r.note ? `<p class="receipt-note">${esc(r.note)}</p>` : ""}
      <div class="receipt-url"><code>${esc(r.url)}</code></div>
      <div class="receipt-actions">
        <button type="button" class="pb-btn pb-btn-small" data-copy="curl">Copy as curl</button>
        <button type="button" class="pb-btn pb-btn-small" data-copy="url">Copy URL</button>
      </div>
    </div>`;
  return el;
}

// A few words that tell two calls to the same tool apart: entity type and the city (or search text).
function contextOf(params) {
  const get = (k) => params.find(([key]) => key === k)?.[1];
  const type = (get("filter.type") || "").replace(/^urn:(entity:)?/, "").replace(/_/g, " ");
  const where = get("filter.location.query") || get("signal.location.query") || get("query");
  return [type, where].filter(Boolean).join(" \u00b7 ");
}

// Split a Qloo URL into its path and a sorted parameter list for the table.
function parseUrl(url) {
  try {
    const u = new URL(url);
    const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return { path: u.pathname, params };
  } catch {
    return { path: String(url || ""), params: [] };
  }
}

// The key is read from the shell, never embedded. Single quotes keep the URL's & intact.
export function curlFor(receipt) {
  const url = String(receipt.url || "").replace(/'/g, "%27");
  return `curl -H "X-Api-Key: $QLOO_API_KEY" '${url}'`;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    // Fallback for non-secure contexts: a temporary textarea and execCommand.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand && document.execCommand("copy");
    ta.remove();
    ok ? resolve() : reject(new Error("copy unsupported"));
  });
}

function flashLabel(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}
