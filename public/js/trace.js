// Renders the agent's work as it happens: turns, tool calls (with the exact Qloo request URL),
// tool results, and streamed text. Judges can expand any call to see parameters and raw results.

import { curlFor } from "./receipts.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export class Trace {
  constructor(root) {
    this.root = root;
    this.calls = new Map();
    this.turn = 0;
    this.qlooCalls = 0;
    this.liveMode = "demo";
    this.root.innerHTML = "";
    document.querySelectorAll("[data-qloo-count]").forEach((n) => (n.textContent = "0"));
    // One delegated handler for every "Copy as curl" button the log will ever render.
    this.root.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-curl]");
      if (!btn) return;
      copyText(curlFor({ url: btn.dataset.curl })).then(
        () => flashLabel(btn, "Copied"),
        () => flashLabel(btn, "Copy failed"),
      );
    });
  }

  // `note` is the server's fixture note ("Recorded demo · placeholder Qloo data" or "... captured <date>"),
  // so the pill never calls hand-written placeholders a Qloo answer.
  setMode(mode, model, note) {
    this.liveMode = mode;
    const pill = document.createElement("div");
    pill.className = "trace-meta";
    let qloo = "Qloo live API";
    if (mode !== "live") {
      const date = /captured\s+(\d{4}-\d{2}-\d{2})/i.exec(note || "")?.[1];
      qloo = /placeholder/i.test(note || "") ? "Qloo placeholder data" : date ? `Qloo data captured ${date}` : "Qloo demo fixtures";
    }
    pill.innerHTML = `<span class="pill ${mode === "live" ? "pill-live" : "pill-demo"}">${esc(qloo)}</span><span class="pill">${esc(model)}</span>`;
    this.root.appendChild(pill);
  }

  status(message) {
    const el = document.createElement("div");
    el.className = "trace-status";
    el.textContent = message;
    this.root.appendChild(el);
    this.scroll();
  }

  startTurn(n) {
    this.turn = n;
    const el = document.createElement("div");
    el.className = "trace-turn";
    el.textContent = `Turn ${n}`;
    this.root.appendChild(el);
    this.scroll();
  }

  thinking(text) {
    let el = this.root.querySelector(`.trace-thinking[data-turn="${this.turn}"]`);
    if (!el) {
      el = document.createElement("div");
      el.className = "trace-thinking";
      el.dataset.turn = String(this.turn);
      el.innerHTML = `<span class="label">thinking</span><span class="body"></span>`;
      this.root.appendChild(el);
    }
    // Append a node rather than resetting textContent so the aria-live log announces only the new text.
    el.querySelector(".body").append(document.createTextNode(text));
    this.scroll();
  }

  toolCall({ id, name, input }) {
    const el = document.createElement("details");
    el.className = "trace-call pending";
    el.dataset.id = id;
    const url = input && typeof input === "object" && typeof input.__url === "string" ? input.__url : null;
    el.innerHTML = `
      <summary>
        <span class="dot" aria-hidden="true"></span>
        <span class="name">${esc(name)}</span>
        <span class="summary-text">${esc(shortInput(input))}</span>
        <span class="ms"></span>
      </summary>
      <div class="call-body">
        <div class="call-section"><div class="call-label">input</div><pre>${esc(JSON.stringify(input, null, 2))}</pre></div>
        <div class="call-section request" hidden><div class="call-label">Qloo request</div><pre class="req"></pre></div>
        <div class="call-section result" hidden><div class="call-label">result</div><pre class="res"></pre></div>
      </div>`;
    this.root.appendChild(el);
    this.calls.set(id, el);
    this.scroll();
  }

  // A failed tool sends ok:false with no data at all; nothing here may assume `data` exists.
  toolResult({ id, name, ok, ms, summary, data }) {
    const el = this.calls.get(id);
    if (!el) return;
    el.classList.remove("pending");
    el.classList.add(ok ? "ok" : "fail");
    el.querySelector(".ms").textContent = typeof ms === "number" ? `${ms} ms` : "";
    // The event's summary is cut at 160 characters; the tool's own summary (when it has one) is whole.
    const fullSummary = typeof data?.summary === "string" && data.summary ? data.summary : summary || "";
    el.querySelector(".summary-text").textContent = fullSummary;
    const reqs = Array.isArray(data?.qloo) ? data.qloo : data?.qloo ? [data.qloo] : [];
    if (reqs.length) {
      const sec = el.querySelector(".request");
      sec.hidden = false;
      // Plain text, not links: the Qloo URLs answer 401 without a key, so there is nothing to click through to.
      sec.querySelector(".req").innerHTML = reqs.map(requestHtml).join("\n\n");
      this.qlooCalls += reqs.length;
      document.querySelectorAll("[data-qloo-count]").forEach((n) => (n.textContent = String(this.qlooCalls)));
    }
    const resSec = el.querySelector(".result");
    resSec.hidden = false;
    let shown = data;
    if (data && typeof data === "object") {
      shown = { ...data };
      delete shown.qloo;
    }
    let text;
    if (shown == null) text = ok ? "(no data returned)" : fullSummary || "(the tool failed and returned no data)";
    else if (typeof shown === "string") text = shown;
    else {
      try {
        text = JSON.stringify(shown, null, 2).slice(0, 6000);
      } catch {
        text = String(shown);
      }
    }
    resSec.querySelector(".res").textContent = text;
    this.scroll();
  }

  error(message) {
    const el = document.createElement("div");
    el.className = "trace-error";
    el.textContent = message;
    this.root.appendChild(el);
    this.scroll();
  }

  scroll() {
    this.root.scrollTop = this.root.scrollHeight;
  }
}

// One Qloo request line: method, the URL as plain code, where it was answered from, and a copy button.
function requestHtml(q) {
  const url = typeof q?.url === "string" ? q.url : "";
  const facts = [q?.mode, typeof q?.status === "number" ? `HTTP ${q.status}` : null, typeof q?.ms === "number" ? `${q.ms} ms` : null, q?.cached ? "cached" : null]
    .filter(Boolean)
    .map(esc)
    .join(" · ");
  const extra = [q?.resolved ? `Qloo matched: ${esc(q.resolved)}` : null, q?.note ? esc(q.note) : null].filter(Boolean);
  return (
    `<span class="method">${esc(q?.method || "GET")}</span> <code>${esc(url)}</code>\n<span class="muted">${facts}</span>` +
    (extra.length ? `\n<span class="muted">${extra.join(" · ")}</span>` : "") +
    (url ? `\n<button type="button" class="copy-curl" data-curl="${esc(url)}">Copy as curl</button>` : "")
  );
}

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.reject(new Error("clipboard unavailable"));
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

function shortInput(input) {
  if (!input || typeof input !== "object") return "";
  const parts = [];
  for (const [k, v] of Object.entries(input)) {
    if (k.startsWith("__")) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${s.length > 40 ? s.slice(0, 40) + "…" : s}`);
    if (parts.join(" ").length > 90) break;
  }
  return parts.join(" · ");
}
