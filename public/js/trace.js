// Renders the agent's work as it happens: turns, tool calls (with the exact Qloo request URL),
// tool results, and streamed text. Judges can expand any call to see parameters and raw results.

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
  }

  setMode(mode, model) {
    this.liveMode = mode;
    const pill = document.createElement("div");
    pill.className = "trace-meta";
    pill.innerHTML = `<span class="pill ${mode === "live" ? "pill-live" : "pill-demo"}">Qloo ${mode === "live" ? "live API" : "demo fixtures"}</span><span class="pill">${esc(model)}</span>`;
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
    el.querySelector(".body").textContent += text;
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

  toolResult({ id, name, ok, ms, summary, data }) {
    const el = this.calls.get(id);
    if (!el) return;
    el.classList.remove("pending");
    el.classList.add(ok ? "ok" : "fail");
    el.querySelector(".ms").textContent = `${ms} ms`;
    el.querySelector(".summary-text").textContent = summary || "";
    const reqs = Array.isArray(data?.qloo) ? data.qloo : data?.qloo ? [data.qloo] : [];
    if (reqs.length) {
      const sec = el.querySelector(".request");
      sec.hidden = false;
      sec.querySelector(".req").innerHTML = reqs
        .map((q) => `<span class="method">GET</span> <a href="${esc(q.url)}" target="_blank" rel="noopener">${esc(q.url)}</a>\n<span class="muted">${esc(q.mode)} · HTTP ${esc(q.status)} · ${esc(q.ms)} ms</span>`)
        .join("\n\n");
      this.qlooCalls += reqs.length;
      document.querySelectorAll("[data-qloo-count]").forEach((n) => (n.textContent = String(this.qlooCalls)));
    }
    const resSec = el.querySelector(".result");
    resSec.hidden = false;
    const shown = data && typeof data === "object" ? { ...data } : data;
    if (shown && typeof shown === "object") delete shown.qloo;
    resSec.querySelector(".res").textContent = typeof shown === "string" ? shown : JSON.stringify(shown, null, 2).slice(0, 6000);
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
