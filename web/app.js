// Library Helper web UI. No build step: plain ES modules talking to /api.

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");

// ---- Utilities ---------------------------------------------------------------

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// Tagged template that escapes interpolations unless they're already-safe html`` output.
class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => {
    out += Array.isArray(v) ? v.map((x) => (x instanceof Safe ? x.s : esc(x))).join("") : v instanceof Safe ? v.s : v === false || v == null ? "" : esc(v);
    out += strings[i + 1];
  });
  return new Safe(out);
}
const render = (s) => { app.innerHTML = String(s); };

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const DAY = 86_400_000;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
// "Nov 8", with the year only when it isn't this year.
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const fmtDay = (s) => {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s ?? "";
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : dateFmt.format(d);
};
const fmtDate = (s) => (s && !Number.isNaN(Date.parse(s)) ? dateFmt.format(new Date(s)) : s ?? "");
// Vega spells e-formats "Ebook" and "Eaudiobook".
const formatName = (f) => (f ?? "").replace(/^E(book|audiobook)$/i, (_, w) => `e${w[0].toUpperCase()}${w.slice(1).toLowerCase()}`);
const plural = (n, w) => `${n} ${n === 1 ? w : /(s|sh|ch|x)$/.test(w) ? `${w}es` : `${w}s`}`;

// Whole calendar days from today to the due date, in local time. Libby loans are due at a
// time of day, so counting elapsed hours would call "tomorrow night" two days away.
function relDue(iso) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((midnight(new Date(iso)) - midnight(new Date())) / DAY);
  if (days < 0) return { text: `Overdue by ${plural(-days, "day")}`, tone: "bad" };
  if (days === 0) return { text: "Due today", tone: "bad" };
  if (days <= 3) return { text: `Due in ${plural(days, "day")}`, tone: "warn" };
  return { text: `Due ${shortFmt.format(new Date(iso))}`, tone: "" };
}

// "Weir, Andy." -> "Andy Weir"
function prettyName(n) {
  if (!n) return "";
  const s = n.replace(/[.,]\s*$/, "").replace(/,\s*\d{4}-?(\d{4})?$/, "");
  const m = s.match(/^([^,]+),\s*([^,]+)$/);
  return m ? `${m[2]} ${m[1]}` : s;
}
// MARC language codes ("eng", "fre") to names; Intl knows the bibliographic codes too.
const languageNames = new Intl.DisplayNames(["en"], { type: "language" });
function languageName(code) {
  if (!code || code === "und") return undefined;
  try { return languageNames.of(code); } catch { return code; }
}
const cleanTitle = (t) => (t ?? "").replace(/\s*[/:]\s*$/, "").replace(/\s+:\s+/, ": ");

const icon = {
  search: '<svg class="i" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>',
  back: '<svg class="i" viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  refresh: '<svg class="i" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>',
  pin: '<svg class="i" viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  phone: '<svg class="i" viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/></svg>',
};
const raw = (s) => new Safe(s);

// Generated cover: a colour from the title, with title and author set in type.
const PALETTE = ["#0f766e", "#1d4ed8", "#7c3aed", "#be185d", "#b45309", "#15803d", "#334155", "#9f1239", "#0e7490", "#4d7c0f"];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
function cover(title, author, { large = false, isbn } = {}) {
  const h = hash(title ?? "");
  const a = PALETTE[h % PALETTE.length], b = PALETTE[(h >> 4) % PALETTE.length];
  const img = isbn ? html`<img alt="" loading="lazy" src="https://covers.openlibrary.org/b/isbn/${isbn}-${large ? "L" : "M"}.jpg?default=false" data-cover>` : "";
  return html`<div class="cover${large ? " lg" : ""}" style="background:linear-gradient(150deg, ${a}, ${b})">
    <span class="t">${cleanTitle(title)}</span><span class="a">${prettyName(author)}</span>${img}</div>`;
}
// Hide Open Library covers that don't exist (it 404s with default=false).
document.addEventListener("error", (e) => { if (e.target.matches?.("img[data-cover]")) e.target.remove(); }, true);

function toast(msg, tone = "") {
  const t = document.createElement("div");
  t.className = `toast ${tone}`;
  t.textContent = msg;
  $("#toasts").append(t);
  setTimeout(() => t.remove(), 4500);
}

// ---- API ---------------------------------------------------------------------

class ApiError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}

async function api(path, { method = "GET", body } = {}) {
  const headers = { Accept: "application/json" };
  const token = store.get("token", "");
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (res.status === 403) {
    if (await askToken()) return api(path, { method, body });
    throw new ApiError(403, "The server refused this request. Check that you're signed in to it.");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`, json.code);
  return json;
}

// Cache the promise, not the result, so pages that ask at the same time share one request.
let config;
const getConfig = () => (config ??= api("/config").catch((e) => { config = undefined; throw e; }));

// The account summary costs several library calls; callers that overlap (the nav badge and
// the account page on first load) share one request.
let accountInFlight;
const getAccount = () => (accountInFlight ??= api("/account").finally(() => { accountInFlight = undefined; }));

// Bearer-token deployments: ask once, remember in this browser.
function askToken() {
  const dlg = $("#dialog");
  dlg.innerHTML = String(html`<form method="dialog">
    <div><h2>Access token</h2><p class="muted small" style="margin-top:6px">This server wants a bearer token (its AUTH_TOKEN). It is stored in this browser only.</p></div>
    <div class="field"><label for="tok">Token</label><input id="tok" class="input" name="token" type="password" autocomplete="off" required></div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Save</button></div>
  </form>`);
  dlg.showModal();
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      const token = dlg.returnValue === "ok" ? $("#tok", dlg).value.trim() : "";
      if (token) store.set("token", token);
      resolve(Boolean(token));
    }, { once: true });
  });
}

// ---- Shared views ---------------------------------------------------------------

const loading = (n = 3) => html`<div class="grid">${Array.from({ length: n }, () => html`<div class="skeleton" style="height:92px"></div>`)}</div>`;
const errorBox = (e) => html`<div class="error-box">${e.message}</div>`;

function noCard() {
  return html`<div class="card empty">
    <h2>No library card configured</h2>
    <p>Set <code>LIBRARY_CARD_NUMBER</code> and <code>LIBRARY_PIN</code> on the server to see loans, holds and fines.</p>
  </div>`;
}

const INDEXES = [["keyword", "Everything"], ["title", "Title"], ["author", "Author"], ["subject", "Subject"], ["series", "Series"], ["call_number", "Call number"]];
const SORTS = [["relevance", "Most relevant"], ["newest", "Newest"], ["title", "Title A–Z"], ["author", "Author A–Z"]];
const options = (list, cur) => list.map(([v, l]) => html`<option value="${v}"${raw(v === cur ? " selected" : "")}>${l}</option>`);

function searchHref(q, index = "keyword", extra = {}) {
  const p = new URLSearchParams({ q, ...(index !== "keyword" && { index }), ...extra });
  return `#/search?${p}`;
}

// ---- Pages -----------------------------------------------------------------------

async function homePage() {
  render(html`
    <section class="hero">
      <h1>Find your next read</h1>
      <p>Search the Lambton County Library catalogue, check availability and manage your card.</p>
      <form class="bigsearch" id="bigsearch" role="search">
        <input class="input" name="q" type="search" placeholder="Title, author, subject or ISBN" aria-label="Search" autofocus>
        <select class="select" name="index" aria-label="Search in">${options(INDEXES, "keyword")}</select>
        <button class="btn primary">${raw(icon.search)} Search</button>
      </form>
    </section>
    <div id="glance"></div>
    <div id="open-now"></div>`);
  $("#bigsearch").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    if (f.get("q").trim()) location.hash = searchHref(f.get("q").trim(), f.get("index"));
  });

  const cfg = await getConfig().catch(() => null);
  if (cfg?.hasCredentials) {
    $("#glance").innerHTML = String(html`<div class="section-head"><h2>Your card</h2><a href="#/account">View account</a></div>${loading(1)}`);
    try {
      const s = await getAccount();
      $("#glance").innerHTML = String(html`<div class="section-head"><h2>Your card</h2><a href="#/account">View account →</a></div>${statTiles(s)}`);
    } catch (e) {
      $("#glance").innerHTML = String(html`<div class="section-head"><h2>Your card</h2></div>${errorBox(e)}`);
    }
  }
  try {
    const h = await api("/hours");
    const open = h.branches.filter((b) => openState(b, h.today).open);
    $("#open-now").innerHTML = String(html`<div class="section-head"><h2>Open now</h2><a href="#/hours">All hours →</a></div>
      ${open.length
        ? html`<div class="tags">${open.map((b) => html`<a href="#/hours?b=${encodeURIComponent(b.name)}">${b.name.replace(/ Library$/, "")} · until ${openState(b, h.today).until}</a>`)}</div>`
        : html`<p class="muted">No branches are open right now.</p>`}`);
  } catch {}
}

function statTiles(s) {
  const tile = (label, value, href, tone = "") => html`<a class="card stat ${tone}" href="${href}"><div class="label">${label}</div><div class="value">${value}</div></a>`;
  return html`<div class="grid stats">
    ${tile("Checked out", s.loans, "#/account/loans")}
    ${tile("Overdue", s.overdue, "#/account/loans", s.overdue ? "alert" : "")}
    ${tile("Due in 3 days", s.dueWithin3Days, "#/account/loans")}
    ${tile("Holds", s.holds, "#/account/holds")}
    ${tile("Ready for pickup", s.holdsReadyForPickup, "#/account/holds", s.holdsReadyForPickup ? "good" : "")}
    ${tile("Owed", money.format(s.moneyOwed ?? 0), "#/account/fines", s.moneyOwed > 0 ? "alert" : "")}
  </div>`;
}

async function searchPage(params) {
  const q = params.get("q") ?? "";
  const index = params.get("index") ?? "keyword";
  const sort = params.get("sort") ?? "relevance";
  const page = Number(params.get("page") ?? 1);
  render(html`
    <form class="search-bar" id="searchform" role="search">
      <input class="input" name="q" type="search" value="${q}" placeholder="Title, author, subject or ISBN" aria-label="Search" ${raw(q ? "" : "autofocus")}>
      <select class="select" name="index" aria-label="Search in">${options(INDEXES, index)}</select>
      <select class="select" name="sort" aria-label="Sort">${options(SORTS, sort)}</select>
      <button class="btn primary" aria-label="Search">${raw(icon.search)}<span class="label">Search</span></button>
    </form>
    <div id="results">${q ? loading(4) : html`<div class="empty"><h2>Search the catalogue</h2><p>Books, large print, DVDs, audiobooks and more.</p></div>`}</div>`);
  const form = $("#searchform");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const nq = f.get("q").trim();
    if (nq) location.hash = searchHref(nq, f.get("index"), f.get("sort") !== "relevance" ? { sort: f.get("sort") } : {});
  });
  form.sort.addEventListener("change", () => form.requestSubmit());
  if (!q) return;

  try {
    const r = await api(`/search?${new URLSearchParams({ q, index, sort, page, limit: 20 })}`);
    if (!r.hits.length) {
      $("#results").innerHTML = String(html`<div class="empty"><h2>No results</h2><p>Try fewer words, or search everything instead of one field.</p></div>`);
      return;
    }
    const pageHref = (p) => searchHref(q, index, { ...(sort !== "relevance" && { sort }), page: p });
    $("#results").innerHTML = String(html`
      <p class="muted small" style="margin-top:16px">${r.total.toLocaleString()} results${r.totalPages > 1 ? ` · page ${r.page} of ${r.totalPages}` : ""}</p>
      <div class="hits">${r.hits.map(hitCard)}</div>
      ${r.totalPages > 1 ? html`<nav class="pager">
        ${r.page > 1 ? html`<a class="btn" href="${pageHref(r.page - 1)}">← Previous</a>` : ""}
        <span class="muted small">Page ${r.page} of ${r.totalPages}</span>
        ${r.page < r.totalPages ? html`<a class="btn" href="${pageHref(r.page + 1)}">Next →</a>` : ""}
      </nav>` : ""}`);
  } catch (e) {
    $("#results").innerHTML = String(html`<div style="margin-top:20px">${errorBox(e)}</div>`);
  }
}

function availabilityPill(status, electronic) {
  if (electronic) return html`<span class="pill accent">Libby</span>`;
  if (!status) return "";
  // Vega sends codes like "CheckedOut" and "CheckAvailability": "Checked out", "Check availability".
  const label = status.replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`);
  const tone = /^available/i.test(label) ? "ok" : /checked out|on order|unavailable|in process/i.test(label) ? "warn" : "";
  return html`<span class="pill ${tone}"><span class="dot"></span>${label}</span>`;
}

function hitCard(hit) {
  const first = hit.formats.flatMap((f) => f.editions)[0];
  const href = first ? `#/record/${first.recordId}` : null;
  return html`<article class="card hit">
    ${href ? html`<a href="${href}" aria-hidden="true" tabindex="-1">${cover(hit.title, hit.author, { isbn: hit.isbn })}</a>` : cover(hit.title, hit.author, { isbn: hit.isbn })}
    <div>
      <h3>${href ? html`<a href="${href}">${cleanTitle(hit.title)}</a>` : cleanTitle(hit.title)}</h3>
      <p class="muted small">${[prettyName(hit.author), hit.year].filter(Boolean).join(" · ")}</p>
      <div class="formats">${hit.formats.map((f) => {
        const ed = f.editions[0];
        const avail = f.branches?.filter((b) => b.available).length ?? 0;
        return html`<div class="format-row">
          <span class="name">${ed ? html`<a href="#/record/${ed.recordId}">${formatName(f.format)}</a>` : formatName(f.format)}</span>
          ${availabilityPill(f.status, f.electronic)}
          ${!f.electronic && f.branches?.length ? html`<span class="muted small">${avail ? `in at ${plural(avail, "branch")}${f.moreBranches ? "+" : ""}` : `${plural(f.branches.length, "branch")}`}</span>` : ""}
          ${f.editions.length > 1 ? html`<span class="muted small">${f.editions.length} editions</span>` : ""}
        </div>`;
      })}</div>
    </div>
  </article>`;
}

async function recordPage(id) {
  render(html`<a class="back" href="#/search" data-back>${raw(icon.back)} Back</a>${loading(2)}`);
  let rec;
  try {
    rec = await api(`/records/${encodeURIComponent(id)}`);
  } catch (e) {
    render(html`<a class="back" href="#/search">${raw(icon.back)} Search</a>${errorBox(e)}`);
    return;
  }
  const author = rec.contributors?.[0]?.name;
  const cfg = await getConfig().catch(() => ({}));
  const meta = [
    ["Format", formatName(rec.format)],
    ["Edition", rec.edition],
    ["Published", rec.published ?? rec.year],
    ["Description", rec.extent?.replace(/\s*[:;,/]\s*$/, "")],
    ["Call number", rec.callNumber],
    ["Language", languageName(rec.language)],
    ["ISBN", rec.isbn?.join(", ")],
  ].filter(([, v]) => v);
  render(html`
    <a class="back" href="#/search" data-back>${raw(icon.back)} Back</a>
    <div class="record">
      <div>${cover(rec.title, author, { large: true, isbn: rec.isbn?.[0] })}</div>
      <div class="stack">
        <div>
          <h1>${cleanTitle(rec.title)}</h1>
          ${author ? html`<p style="margin-top:8px;font-size:1.05rem">by ${rec.contributors.filter((c) => !c.role || c.role === "aut").slice(0, 3).map((c, i) => html`${i ? ", " : ""}<a href="${searchHref(c.name.replace(/[.,]$/, ""), "author")}">${prettyName(c.name)}</a>`)}</p>` : ""}
        </div>
        <div class="row">
          ${availabilityPill(rec.status)}
          ${cfg.hasCredentials ? html`<button class="btn primary" id="hold-btn">Place hold</button>` : ""}
        </div>
        ${rec.summary ? html`<p class="summary">${rec.summary}</p>` : ""}
        <dl class="meta">${meta.map(([k, v]) => html`<dt>${k}</dt><dd>${v}</dd>`)}</dl>
        ${rec.subjects?.length ? html`<div><h3 style="margin-bottom:8px">Subjects</h3><div class="tags">${rec.subjects.map((s) => html`<a href="${searchHref(s.replace(/--/g, " "), "subject")}">${s.replace(/--/g, " › ")}</a>`)}</div></div>` : ""}
        ${rec.otherFormats?.length ? html`<div><h3 style="margin-bottom:8px">Other formats &amp; editions</h3><div class="tags">${rec.otherFormats.map((f) => html`<a href="#/record/${f.recordId}">${formatName(f.format)}${f.year ? ` · ${f.year}` : ""}</a>`)}</div></div>` : ""}
      </div>
    </div>
    <div class="section-head"><h2>Copies</h2><span class="muted small" id="copy-count"></span></div>
    <div id="copies">${loading(1)}</div>`);
  $("#hold-btn")?.addEventListener("click", () => holdDialog(rec));

  try {
    const copies = await api(`/records/${encodeURIComponent(id)}/availability`);
    const avail = copies.filter((c) => c.available).length;
    $("#copy-count").textContent = `${avail} of ${copies.length} ${copies.length === 1 ? "copy" : "copies"} available`;
    copies.sort((a, b) => Number(b.available) - Number(a.available) || (a.branch ?? "").localeCompare(b.branch ?? ""));
    $("#copies").innerHTML = String(copies.length
      ? html`<div class="card table-wrap"><table class="table copies">
          <thead><tr><th>Branch</th><th class="call">Call number</th><th>Status</th><th>Due</th></tr></thead>
          <tbody>${copies.map((c) => html`<tr>
            <td>${c.branch}${c.volume ? html` <span class="muted small">${c.volume}</span>` : ""}</td>
            <td class="call">${c.callNumber}</td>
            <td><span class="pill ${c.available ? "ok" : "warn"}"><span class="dot"></span>${c.status}</span></td>
            <td class="muted nowrap">${c.dueDate ? fmtDay(c.dueDate) : "—"}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted">No physical copies. This may be a Libby title.</p>`);
  } catch (e) {
    $("#copies").innerHTML = String(errorBox(e));
  }
}

async function holdDialog(rec) {
  const cfg = await getConfig();
  let preferred = store.get("pickup", "");
  if (!preferred) {
    const s = await getAccount().catch(() => null);
    preferred = cfg.pickupLocations.find((p) => p.name === s?.preferredPickupLocation)?.code ?? "";
  }
  const dlg = $("#dialog");
  dlg.innerHTML = String(html`<form method="dialog">
    <div><h2>Place a hold</h2><p class="muted small" style="margin-top:6px">${cleanTitle(rec.title)}${rec.format ? ` · ${formatName(rec.format)}` : ""}</p></div>
    <div class="field"><label for="pickup">Pick up at</label>
      <select id="pickup" class="select" name="pickup" required>
        <option value="">Choose a branch…</option>
        ${cfg.pickupLocations.map((p) => html`<option value="${p.code}"${raw(p.code === preferred ? " selected" : "")}>${p.name}</option>`)}
      </select></div>
    <p class="muted small">Ready holds are kept for 7 days.</p>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok">Place hold</button></div>
  </form>`);
  dlg.showModal();
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    const pickupLocation = $("#pickup", dlg).value;
    store.set("pickup", pickupLocation);
    const btn = $("#hold-btn");
    if (btn) btn.disabled = true;
    try {
      const r = await api("/holds", { method: "POST", body: { recordId: rec.recordId, pickupLocation } });
      toast(`Hold placed for pickup at ${r.pickupLocation?.name ?? "your branch"}.`);
      refreshBadge();
    } catch (e) {
      toast(e.message, "bad");
    } finally {
      if (btn) btn.disabled = false;
    }
  }, { once: true });
}

// ---- Account ------------------------------------------------------------------

const TABS = [["loans", "Checked out"], ["holds", "Holds"], ["fines", "Fines"], ["history", "History"]];

async function accountPage(tab = "loans") {
  const cfg = await getConfig().catch((e) => ({ error: e }));
  if (cfg.error) return render(errorBox(cfg.error));
  if (!cfg.hasCredentials) return render(noCard());
  render(html`
    <div class="row spread"><h1>My account</h1><span class="muted small" id="card-meta"></span></div>
    <div id="summary" style="margin-top:20px">${loading(1)}</div>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="#/account/${k}" class="${k === tab ? "active" : ""}">${l}<span class="count" data-count="${k}" hidden></span></a>`)}</nav>
    <div id="tab">${loading(3)}</div>`);

  getAccount().then((s) => {
    $("#summary").innerHTML = String(statTiles(s));
    $("#card-meta").textContent = [s.homeLibrary && `Home: ${s.homeLibrary}`, s.cardExpires && `Card expires ${fmtDate(s.cardExpires)}`].filter(Boolean).join(" · ");
    setCount("loans", s.loans);
    setCount("holds", s.holds);
    updateBadge(s);
  }).catch((e) => { $("#summary").innerHTML = String(errorBox(e)); });

  const view = { loans: loansTab, holds: holdsTab, fines: finesTab, history: historyTab }[tab] ?? loansTab;
  try {
    await view($("#tab"));
  } catch (e) {
    $("#tab").innerHTML = String(errorBox(e));
  }
}

function setCount(k, n) {
  const el = $(`[data-count="${k}"]`);
  if (el) { el.textContent = n; el.hidden = false; }
}

async function loansTab(el) {
  const loans = await api("/loans");
  if (!loans.length) {
    el.innerHTML = String(html`<div class="card empty"><h2>Nothing checked out</h2><p><a href="#/search">Find something to read →</a></p></div>`);
    return;
  }
  const renewable = loans.filter((l) => l.canRenew);
  el.innerHTML = String(html`<div class="card">
    <div class="toolbar">
      <label class="row" style="gap:8px"><input type="checkbox" class="check" id="all" ${raw(renewable.length ? "" : "disabled")}> Select renewable</label>
      <button class="btn primary sm" id="renew-sel" disabled>${raw(icon.refresh)} Renew selected</button>
    </div>
    <div class="list">${loans.map((l) => {
      const due = relDue(l.dueDate);
      return html`<div class="item">
        <input type="checkbox" class="check" name="loan" value="${l.checkoutId}" aria-label="Select ${l.title}" ${raw(l.canRenew ? "" : "disabled")}>
        <div>
          <div class="title">${cleanTitle(l.title)}</div>
          <div class="sub">
            ${l.format ? html`<span>${formatName(l.format)}</span>` : ""}
            ${l.source !== "library" ? html`<span title="${l.note ?? ""}">Libby · renew in the app</span>` : ""}
            ${l.renewalLimit != null ? html`<span>Renewed ${l.renewals ?? 0} of ${l.renewalLimit}</span>` : ""}
          </div>
        </div>
        <div class="actions">
          <span class="pill ${due.tone}">${due.text}</span>
          ${l.canRenew ? html`<button class="btn sm" data-renew="${l.checkoutId}">Renew</button>` : ""}
        </div>
      </div>`;
    })}</div></div>`);

  const boxes = [...el.querySelectorAll('input[name="loan"]:not(:disabled)')];
  const sync = () => { $("#renew-sel", el).disabled = !boxes.some((b) => b.checked); };
  boxes.forEach((b) => b.addEventListener("change", sync));
  $("#all", el).addEventListener("change", (e) => { boxes.forEach((b) => (b.checked = e.target.checked)); sync(); });
  const renew = async (ids, btn) => {
    btn.disabled = true;
    try {
      const results = await api("/loans/renew", { method: "POST", body: { checkoutIds: ids } });
      const ok = results.filter((r) => r.renewed).length;
      const failed = results.filter((r) => !r.renewed);
      if (ok) toast(`Renewed ${plural(ok, "item")}.`);
      for (const f of failed) toast(`Couldn't renew: ${f.reason}`, "bad");
      route();
    } catch (e) {
      toast(e.message, "bad");
      btn.disabled = false;
    }
  };
  $("#renew-sel", el).addEventListener("click", (e) => renew(boxes.filter((b) => b.checked).map((b) => b.value), e.currentTarget));
  el.querySelectorAll("[data-renew]").forEach((b) => b.addEventListener("click", () => renew([b.dataset.renew], b)));
}

async function holdsTab(el) {
  const holds = await api("/holds");
  if (!holds.length) {
    el.innerHTML = String(html`<div class="card empty"><h2>No holds</h2><p>Place a hold from any catalogue record.</p></div>`);
    return;
  }
  holds.sort((a, b) => Number(b.readyForPickup) - Number(a.readyForPickup) || (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  el.innerHTML = String(html`<div class="card list">${holds.map((h) => html`<div class="item">
    <span></span>
    <div>
      <div class="title">${h.recordId ? html`<a href="#/record/${h.recordId}" style="color:inherit">${cleanTitle(h.title)}</a>` : cleanTitle(h.title)}</div>
      <div class="sub">
        ${h.format ? html`<span>${formatName(h.format)}</span>` : ""}
        ${h.pickupLocation ? html`<span>Pickup: ${h.pickupLocation.name}</span>` : ""}
        ${h.queuePosition != null && !h.readyForPickup ? html`<span>#${h.queuePosition} in line</span>` : ""}
        ${h.expires ? html`<span>${h.readyForPickup ? "Pick up by" : "Expires"} ${fmtDate(h.expires)}</span>` : ""}
        ${h.frozen ? html`<span>Frozen</span>` : ""}
      </div>
    </div>
    <div class="actions">
      <span class="pill ${h.readyForPickup ? "ok" : h.status === "in transit" ? "accent" : ""}">${h.readyForPickup ? "Ready for pickup" : h.status}</span>
      <button class="btn sm danger" data-cancel="${h.holdId}" data-title="${cleanTitle(h.title)}">Cancel</button>
    </div>
  </div>`)}</div>`);
  el.querySelectorAll("[data-cancel]").forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog(`Cancel the hold on “${b.dataset.title}”?`, "You'll lose your place in line. This can't be undone.", "Cancel hold"))) return;
    b.disabled = true;
    try {
      const [r] = await api("/holds/cancel", { method: "POST", body: { holdIds: [b.dataset.cancel] } });
      if (r?.cancelled) toast("Hold cancelled.");
      else toast(`Couldn't cancel: ${r?.reason ?? "unknown error"}`, "bad");
      route();
    } catch (e) {
      toast(e.message, "bad");
      b.disabled = false;
    }
  }));
}

function confirmDialog(title, body, action) {
  const dlg = $("#dialog");
  dlg.innerHTML = String(html`<form method="dialog">
    <div><h2>${title}</h2><p class="muted small" style="margin-top:6px">${body}</p></div>
    <div class="actions"><button class="btn" value="no">Keep it</button><button class="btn primary" value="yes">${action}</button></div>
  </form>`);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true }));
}

async function finesTab(el) {
  const f = await api("/fines");
  el.innerHTML = String(html`<div class="card">
    <div class="toolbar"><strong>Total outstanding</strong><strong>${money.format(f.totalOutstanding)}</strong></div>
    ${f.fines.length
      ? html`<div class="table-wrap"><table class="table"><thead><tr><th>Item</th><th>Charge</th><th>Date</th><th class="num">Amount</th></tr></thead><tbody>
          ${f.fines.map((x) => html`<tr>
            <td>${cleanTitle(x.title) || x.description || "—"}${x.title && x.description ? html`<div class="muted small">${x.description}</div>` : ""}</td>
            <td class="muted">${x.type ?? ""}</td>
            <td class="muted">${fmtDate(x.date)}</td>
            <td class="num">${money.format(x.amount)}</td></tr>`)}
        </tbody></table></div>`
      : html`<div class="empty"><h2>All clear</h2><p>No fines or fees on this card.</p></div>`}
  </div>`);
}

async function historyTab(el) {
  const h = await api("/history");
  if (!h.enabled) {
    el.innerHTML = String(html`<div class="card empty"><h2>Reading history is off</h2><p>${h.message}</p></div>`);
    return;
  }
  if (!h.items.length) {
    el.innerHTML = String(html`<div class="card empty"><h2>No history yet</h2></div>`);
    return;
  }
  el.innerHTML = String(html`<p class="muted small" style="margin-bottom:10px">${h.total} items</p><div class="card list">${h.items.map((x) => {
    const title = cleanTitle(x.title);
    const href = x.recordId ? `#/record/${x.recordId}` : searchHref(title, "title");
    return html`<div class="item"><span></span><div>
      <div class="title"><a href="${href}" style="color:inherit">${title}</a></div>
      <div class="sub">${x.author ? html`<span>${prettyName(x.author)}</span>` : ""}${x.format ? html`<span>${formatName(x.format)}</span>` : ""}</div>
    </div><div class="actions muted small">${fmtDate(x.checkedOut)}</div></div>`;
  })}</div>`);
}

// ---- Hours --------------------------------------------------------------------

const WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// "10AM", "12:30PM" -> minutes after midnight
function minutes(t) {
  const m = t.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*([AP])M$/i);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return h * 60 + Number(m[2] ?? 0);
}

function openState(b, today) {
  const range = b.hours?.[today.weekday];
  if (b.note || !range) return { open: false };
  const [from, to] = range.split(" - ");
  const [hh, mm] = today.time.split(":").map(Number);
  const now = hh * 60 + mm, start = minutes(from ?? ""), end = minutes(to ?? "");
  if (start == null || end == null) return { open: false };
  return { open: now >= start && now < end, until: to, opensAt: now < start ? from : null };
}

async function hoursPage(params) {
  render(html`<div class="row spread"><h1>Branches &amp; hours</h1>
    <input class="input" id="bfilter" type="search" placeholder="Filter branches" style="max-width:260px" value="${params.get("b") ?? ""}"></div>
    <div id="hours" style="margin-top:20px">${loading(3)}</div>`);
  let h;
  try {
    h = await api("/hours");
  } catch (e) {
    $("#hours").innerHTML = String(errorBox(e));
    return;
  }
  const draw = () => {
    const f = $("#bfilter").value.trim().toLowerCase();
    const list = h.branches.filter((b) => !f || b.name.toLowerCase().includes(f));
    $("#hours").innerHTML = String(html`
      <div class="grid branches">${list.map((b) => {
        const st = openState(b, h.today);
        const pill = b.note ? html`<span class="pill bad">${b.note}</span>`
          : st.open ? html`<span class="pill ok"><span class="dot"></span>Open until ${st.until}</span>`
          : html`<span class="pill">${st.opensAt ? `Opens ${st.opensAt}` : "Closed now"}</span>`;
        return html`<article class="card branch">
          <div class="row spread" style="align-items:flex-start"><h3>${b.url ? html`<a href="${b.url}" target="_blank" rel="noopener" style="color:inherit">${b.name}</a>` : b.name}</h3>${pill}</div>
          <div class="week">${WEEK.map((d) => html`<span class="d ${d === h.today.weekday ? "today" : ""}">${d.slice(0, 3)}</span><span class="${d === h.today.weekday ? "today" : "muted"}">${b.hours[d] ?? "Closed"}</span>`)}</div>
          <div class="muted small" style="display:grid;gap:4px">
            ${b.address ? html`<span class="row" style="gap:6px;flex-wrap:nowrap">${raw(icon.pin)}${b.address}</span>` : ""}
            ${b.phone ? html`<a class="row" style="gap:6px" href="tel:${b.phone.replace(/[^\d+]/g, "")}">${raw(icon.phone)}${b.phone}</a>` : ""}
          </div>
        </article>`;
      })}</div>
      ${list.length ? "" : html`<div class="empty">No branch matches “${f}”.</div>`}
      <p class="muted small" style="margin-top:20px">From <a href="${h.source}" target="_blank" rel="noopener">the library website</a>. Holiday closures aren't listed.</p>`);
  };
  $("#bfilter").addEventListener("input", draw);
  draw();
}

// ---- Router -----------------------------------------------------------------

function updateBadge(s) {
  const b = $("#nav-badge");
  const n = (s.overdue ?? 0) + (s.holdsReadyForPickup ?? 0);
  b.hidden = !n;
  b.textContent = n;
  b.className = `badge${s.overdue ? " bad" : ""}`;
  b.title = [s.overdue && `${s.overdue} overdue`, s.holdsReadyForPickup && `${s.holdsReadyForPickup} ready for pickup`].filter(Boolean).join(", ");
}
async function refreshBadge() {
  const cfg = await getConfig().catch(() => null);
  if (cfg?.hasCredentials) getAccount().then(updateBadge).catch(() => {});
}

async function route() {
  const [path, query = ""] = location.hash.replace(/^#/, "").split("?");
  const params = new URLSearchParams(query);
  const parts = path.split("/").filter(Boolean);
  const section = parts[0] ?? "";
  document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("active", a.dataset.nav === section || (section === "record" && a.dataset.nav === "search")));
  $("#topsearch").hidden = section === "" || section === "search";
  const titles = { search: params.get("q") ? `${params.get("q")} – Search` : "Search", account: "My account", hours: "Hours", record: "Record" };
  document.title = titles[section] ? `${titles[section]} · Library Helper` : "Library Helper";

  if (section === "search") await searchPage(params);
  else if (section === "record" && parts[1]) await recordPage(parts[1]);
  else if (section === "account") await accountPage(parts[1]);
  else if (section === "hours") await hoursPage(params);
  else await homePage();
}

$("#topsearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) { location.hash = searchHref(q); e.target.q.value = ""; }
});
let lastPath = "";
window.addEventListener("hashchange", () => {
  const path = location.hash.split("?")[0];
  if (path !== lastPath) window.scrollTo(0, 0);
  lastPath = path;
  route();
});
// "Back" links go back in history when there is somewhere to go back to.
document.addEventListener("click", (e) => {
  const a = e.target.closest?.("[data-back]");
  if (a && history.length > 1) { e.preventDefault(); history.back(); }
});
lastPath = location.hash.split("?")[0];
route();
refreshBadge();
