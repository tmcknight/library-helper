// Library Helper web UI. No build step: plain ES modules talking to /api.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
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
const raw = (s) => new Safe(s);
const render = (s) => { app.innerHTML = String(s); };
const fill = (el, s) => { if (el) el.innerHTML = String(s); };

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const DAY = 86_400_000;
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const longFmt = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" });
const money = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD" });
// A bare "2027-05-01" parses as UTC midnight, which is the day before in Ontario; read it as local.
const toDate = (s) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(s ?? "") ? `${s}T00:00` : s);
const valid = (d) => !Number.isNaN(d.getTime());
// "Nov 8", with the year only when it isn't this year.
const fmtDay = (s) => {
  const d = toDate(s);
  if (!valid(d)) return s ?? "";
  return d.getFullYear() === new Date().getFullYear() ? dayFmt.format(d) : dateFmt.format(d);
};
const fmtDate = (s) => (s && valid(toDate(s)) ? dateFmt.format(toDate(s)) : s ?? "");
// Vega spells e-formats "Ebook" and "Eaudiobook".
const formatName = (f) => (f ?? "").replace(/^E(book|audiobook)$/i, (_, w) => `e${w[0].toUpperCase()}${w.slice(1).toLowerCase()}`);
const capitalize = (s) => (s ? s[0].toUpperCase() + s.slice(1) : "");
const plural = (n, w) => `${n} ${n === 1 ? w : /(s|sh|ch|x)$/.test(w) ? `${w}es` : `${w}s`}`;
const listJoin = (xs) => new Intl.ListFormat("en", { type: "conjunction" }).format(xs);

// Whole calendar days from today to the due date, in local time. Libby loans are due at a
// time of day, so counting elapsed hours would call "tomorrow night" two days away.
function daysUntil(iso) {
  const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(toDate(iso)) - midnight(new Date())) / DAY);
}
function relDue(iso) {
  const days = daysUntil(iso);
  if (days < 0) return { text: `${plural(-days, "day")} overdue`, tone: "bad" };
  if (days === 0) return { text: "Due today", tone: "bad" };
  if (days === 1) return { text: "Due tomorrow", tone: "warn" };
  if (days <= 3) return { text: `Due in ${days} days`, tone: "warn" };
  return { text: `Due ${shortFmt.format(toDate(iso))}`, tone: "" };
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
const shortBranch = (n) => (n ?? "").replace(/ (Branch )?Library$/, "");

const svg = (cls, d) => `<svg class="${cls}" aria-hidden="true" viewBox="0 0 24 24">${d}</svg>`;
const icon = {
  search: svg("i", '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  back: svg("i", '<path d="m15 18-6-6 6-6"/>'),
  next: svg("i", '<path d="m9 18 6-6-6-6"/>'),
  go: svg("i go", '<path d="m9 18 6-6-6-6"/>'),
  chev: svg("i chev", '<path d="m6 9 6 6 6-6"/>'),
  bookmark: svg("i", '<path d="M7 3.5h10a1 1 0 0 1 1 1V21l-6-4-6 4V4.5a1 1 0 0 1 1-1z"/>'),
  refresh: svg("i", '<path d="M20 12a8 8 0 1 1-2.6-5.9L20 8.5"/><path d="M20 3.5v5h-5"/>'),
  pin: svg("i", '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'),
  phone: svg("i", '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>'),
  link: svg("i", '<path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
  check: svg("i", '<path d="m5 12.5 4.5 4.5L19 7.5"/>'),
  clock: svg("i", '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  alert: svg("i", '<path d="M12 8v5"/><path d="M12 16.5v.01"/><circle cx="12" cy="12" r="8.5"/>'),
  user: svg("i", '<circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>'),
};

// Covers, best first: the library's own (Syndetics, the `cover` the API sends), then Open
// Library by ISBN, then a generated one: a colour from the title, with title and author set
// in type. The generated cover is always underneath, so a missing image just reveals it.
const PALETTE = ["#0f6b5f", "#1e4fa8", "#6d3fc4", "#a8285e", "#a65a12", "#1f7a43", "#3a4656", "#8c1d3a", "#0e6a82", "#557017"];
function hash(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); }
const openLibrary = (isbn, large) => `https://covers.openlibrary.org/b/isbn/${encodeURIComponent(isbn)}-${large ? "L" : "M"}.jpg?default=false`;
function cover(title, author, { size = "", isbn, src } = {}) {
  const h = hash(title ?? "");
  const a = PALETTE[h % PALETTE.length], b = PALETTE[(h >> 4) % PALETTE.length];
  const large = size === "lg";
  const first = src ? (large ? src.replace("mc.gif", "lc.gif") : src) : isbn ? openLibrary(isbn, large) : "";
  const fallback = src && isbn ? openLibrary(isbn, large) : "";
  const img = first ? html`<img alt="" loading="lazy" src="${first}" data-cover data-fallback="${fallback}">` : "";
  return html`<div class="cover ${size}" style="background:linear-gradient(155deg, ${a}, ${b})">
    <span class="t">${cleanTitle(title)}</span><span class="a">${prettyName(author)}</span>${img}</div>`;
}
// Syndetics never 404s: a missing cover is its grey placeholder (143×200, or 286×400 large)
// or a 1×1 pixel. Open Library 404s (default=false). Either way, try the next source.
function coverMissed(img) {
  if (img.dataset.fallback) {
    img.src = img.dataset.fallback;
    img.dataset.fallback = "";
  } else {
    img.remove();
  }
}
document.addEventListener("load", (e) => {
  const img = e.target;
  if (!img.matches?.("img[data-cover]")) return;
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w <= 1 || (w === 143 && h === 200) || (w === 286 && h === 400)) coverMissed(img);
  else img.classList.add("loaded");
}, true);
document.addEventListener("error", (e) => { if (e.target.matches?.("img[data-cover]")) coverMissed(e.target); }, true);

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
  if (!res.ok) {
    // Signed out underneath us (session expired, server restarted, PIN changed): forget the
    // cached config so the page shows the sign-in form again.
    if (res.status === 401 && path !== "/login") signedOut();
    throw new ApiError(res.status, json.error ?? `HTTP ${res.status}`, json.code);
  }
  return json;
}

// Cache the promise, not the result, so pages that ask at the same time share one request.
let config;
const getConfig = () => (config ??= api("/config").catch((e) => { config = undefined; throw e; }));

function signedOut() {
  const wasIn = config;
  config = undefined;
  updateBadge({});
  if (wasIn) wasIn.then((c) => { if (c.hasCredentials) setTimeout(route); }).catch(() => {});
}

async function signIn(form) {
  const btn = $("button[type=submit]", form);
  const err = $(".form-error", form);
  btn.disabled = true;
  err.hidden = true;
  try {
    await api("/login", { method: "POST", body: { cardNumber: form.card.value, pin: form.pin.value } });
    config = undefined;
    toast("Signed in.");
    refreshBadge();
    await route();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    btn.disabled = false;
    form.pin.select();
  }
}

async function signOut() {
  try {
    await api("/logout", { method: "POST", body: {} });
  } catch (e) {
    toast(e.message, "bad");
    return;
  }
  config = undefined;
  updateBadge({});
  toast("Signed out.");
  location.hash = "#/";
  route();
}

function signInPanel(intro = "Sign in to see your loans, holds, lists and fines.") {
  return html`<div class="panel signin">
    <h2>Sign in</h2>
    <p class="sub">${intro}</p>
    <form id="signin" autocomplete="on">
      <div class="field"><label for="card">Library card number</label>
        <input id="card" class="input" name="card" inputmode="numeric" autocomplete="username" required autofocus></div>
      <div class="field"><label for="pin">PIN</label>
        <input id="pin" class="input" name="pin" type="password" autocomplete="current-password" required></div>
      <p class="form-error" role="alert" hidden></p>
      <button class="btn primary" type="submit">Sign in</button>
    </form>
    <p class="muted small">Your card and PIN go to the library to sign in and aren't stored. You stay signed in on this browser until you sign out.</p>
  </div>`;
}
function wireSignIn() {
  const form = $("#signin");
  form?.addEventListener("submit", (e) => { e.preventDefault(); signIn(form); });
}

// The account summary costs several library calls; callers that overlap (the nav badge and
// the account page on first load) share one request.
let accountInFlight;
const getAccount = () => (accountInFlight ??= api("/account").finally(() => { accountInFlight = undefined; }));

// Bearer-token deployments: ask once, remember in this browser.
function askToken() {
  const dlg = $("#dialog");
  fill(dlg, html`<form method="dialog">
    <div><h2>Access token</h2><p class="sub">This server wants a bearer token (its AUTH_TOKEN). It's stored in this browser only.</p></div>
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

const skeleton = (n = 3, h = 76) => html`<div style="display:grid;gap:10px">${Array.from({ length: n }, () => html`<div class="skeleton" style="height:${h}px"></div>`)}</div>`;
const errorBox = (e) => html`<div class="error-box">${e.message}</div>`;
const emptyState = (title, body, cta) => html`<div class="panel empty"><h2>${title}</h2>${body ? html`<p>${body}</p>` : ""}${cta ?? ""}</div>`;
const searchCta = html`<a class="btn primary" href="#/search">Search the catalogue</a>`;

const INDEXES = [["keyword", "Everything"], ["title", "Title"], ["author", "Author"], ["subject", "Subject"], ["series", "Series"], ["call_number", "Call number"]];
const SORTS = [["relevance", "Most relevant"], ["newest", "Newest"], ["title", "Title A–Z"], ["author", "Author A–Z"]];
const options = (list, cur) => list.map(([v, l]) => html`<option value="${v}"${raw(v === cur ? " selected" : "")}>${l}</option>`);

// The branch filter is remembered in this browser, so every search (from the box, an author
// link, a subject tag) keeps to "my branch" until it's changed back to all branches.
const savedBranch = () => store.get("branch", "");
function searchHref(q, index = "keyword", extra = {}) {
  const { branch = savedBranch(), ...rest } = extra;
  const p = new URLSearchParams({ q, ...(index !== "keyword" && { index }), ...(branch && { branch }), ...rest });
  return `#/search?${p}`;
}

// The big search box with field chips under it, used on the home and search pages.
function searchForm(id, { q = "", index = "keyword", branch = savedBranch(), autofocus = false } = {}) {
  return html`<form id="${id}" role="search" autocomplete="off">
    <div class="searchbox">
      ${raw(icon.search)}
      <input name="q" type="search" value="${q}" placeholder="Title, author, subject or ISBN" aria-label="Search the catalogue" ${raw(autofocus ? "autofocus" : "")}>
      <button class="btn primary" aria-label="Search">${raw(icon.search)}<span class="btn-label">Search</span></button>
    </div>
    <input type="hidden" name="index" value="${index}">
    <div class="filters">
      <div class="chips" role="group" aria-label="Search in">${INDEXES.map(([v, l]) => html`<button type="button" class="chip" data-index="${v}" aria-pressed="${String(v === index)}">${l}</button>`)}</div>
      <label class="branch-filter${branch ? " on" : ""}">${raw(icon.pin)}<span class="sr-only">Branch</span>
        <select name="branch" class="select bare" data-branch="${branch}"><option value="">All branches</option></select>
      </label>
    </div>
  </form>`;
}
function wireSearchForm(form, extra = () => ({})) {
  const go = () => {
    const q = form.q.value.trim();
    // Until the branch list arrives the select is empty; keep the branch the form started with.
    const branch = form.branch.options.length > 1 ? form.branch.value : form.branch.dataset.branch;
    if (q) location.hash = searchHref(q, form.index.value, { ...extra(), branch });
    else form.q.focus();
  };
  const sel = form.branch;
  getConfig().then((cfg) => {
    sel.insertAdjacentHTML("beforeend", String(html`${cfg.branches.map((b) => html`<option value="${b.code}"${raw(b.code === sel.dataset.branch ? " selected" : "")}>${shortBranch(b.name)}</option>`)}`));
  }).catch(() => {});
  sel.addEventListener("change", () => {
    store.set("branch", sel.value);
    sel.parentElement.classList.toggle("on", Boolean(sel.value));
    if (form.q.value.trim()) go();
  });
  form.addEventListener("submit", (e) => { e.preventDefault(); go(); });
  $$("[data-index]", form).forEach((b) => b.addEventListener("click", () => {
    form.index.value = b.dataset.index;
    $$("[data-index]", form).forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    go();
  }));
}

function pager(page, totalPages, href) {
  if (totalPages <= 1) return "";
  return html`<nav class="pager" aria-label="Pages">
    ${page > 1 ? html`<a class="btn" href="${href(page - 1)}">${raw(icon.back)} Previous</a>` : html`<span></span>`}
    <span class="muted small">Page ${page} of ${totalPages}</span>
    ${page < totalPages ? html`<a class="btn" href="${href(page + 1)}">Next ${raw(icon.next)}</a>` : html`<span></span>`}
  </nav>`;
}

// ---- Home -----------------------------------------------------------------------

async function homePage() {
  render(html`
    <section class="hero">
      <p class="eyebrow">${longFmt.format(new Date())}</p>
      <h1 style="margin-top:10px">Find your next read</h1>
      <p>Search the Lambton County Library catalogue, see what's on the shelf and keep track of your books.</p>
      <div class="bigsearch">${searchForm("bigsearch", { autofocus: !matchMedia("(pointer: coarse)").matches })}</div>
    </section>
    <div id="mine"></div>
    <div id="open-now"></div>`);
  wireSearchForm($("#bigsearch"));

  const [cfg, hours] = await Promise.all([getConfig().catch(() => null), api("/hours").catch(() => null)]);
  if (hours) fill($("#open-now"), openNow(hours));
  if (cfg?.hasCredentials) await myBooksAtAGlance($("#mine"));
  else if (cfg) fill($("#mine"), html`<section class="section"><a class="callout info" href="#/account">
    <span class="ic">${raw(icon.user)}</span><span class="body"><strong>Sign in with your library card</strong><span class="muted small">See what's due, your holds and your lists.</span></span>${raw(icon.go)}</a></section>`);
}

async function myBooksAtAGlance(el) {
  fill(el, html`<section class="section">${skeleton(2, 64)}</section>`);
  let loans, holds;
  try {
    [loans, holds] = await Promise.all([api("/loans"), api("/holds")]);
  } catch (e) {
    fill(el, html`<section class="section">${errorBox(e)}</section>`);
    return;
  }
  loans.sort((a, b) => toDate(a.dueDate) - toDate(b.dueDate));
  const ready = holds.filter((h) => h.readyForPickup);
  const overdue = loans.filter((l) => daysUntil(l.dueDate) < 0);
  const dueSoon = loans.filter((l) => { const d = daysUntil(l.dueDate); return d >= 0 && d <= 3; });

  const callout = (tone, ic, title, sub, href) => html`<a class="callout ${tone}" href="${href}">
    <span class="ic">${raw(ic)}</span><span class="body"><strong>${title}</strong><span class="muted small">${sub}</span></span>${raw(icon.go)}</a>`;
  const where = [...new Set(ready.map((h) => shortBranch(h.pickupLocation?.name)).filter(Boolean))].join(", ");
  const callouts = [
    ready.length && callout("ok", icon.check,
      ready.length === 1 ? `“${cleanTitle(ready[0].title)}” is ready for pickup` : `${ready.length} holds are ready for pickup`,
      [where, ready.length === 1 && ready[0].expires && `pick up by ${fmtDay(ready[0].expires)}`].filter(Boolean).join(" · "),
      "#/borrowed/holds"),
    overdue.length && callout("bad", icon.alert,
      overdue.length === 1 ? `“${cleanTitle(overdue[0].title)}” is overdue` : `${overdue.length} items are overdue`,
      "Renew or return it to stop fines adding up", "#/borrowed/loans"),
    dueSoon.length && callout("warn", icon.clock,
      dueSoon.length === 1 ? `“${cleanTitle(dueSoon[0].title)}” is ${relDue(dueSoon[0].dueDate).text.toLowerCase()}` : `${dueSoon.length} items are due in the next 3 days`,
      dueSoon.some((l) => l.canRenew) ? "You can renew it from Borrowed" : "Return it to any branch", "#/borrowed/loans"),
  ].filter(Boolean);

  fill(el, html`<div class="fade-in">
    ${callouts.length ? html`<section class="section callouts">${callouts}</section>` : ""}
    <section class="section">
      <div class="section-head"><h2>On your shelf</h2><a href="#/borrowed">Borrowed →</a></div>
      ${loans.length
        ? html`<div class="shelf">${loans.map((l) => {
            const due = relDue(l.dueDate);
            return html`<a href="#/borrowed/loans" title="${cleanTitle(l.title)}">${cover(l.title, undefined, { src: l.cover })}<div class="title">${cleanTitle(l.title)}</div><span class="tag ${due.tone}">${due.text}</span></a>`;
          })}</div>`
        : html`<p class="muted">Nothing checked out right now${holds.length ? html` · <a href="#/borrowed/holds">${plural(holds.length, "hold")} on the way</a>` : ""}.</p>`}
    </section>
  </div>`);
}

function openNow(h) {
  const open = h.branches.map((b) => ({ b, st: openState(b, h.today) })).filter((x) => x.st.open);
  return html`<section class="section fade-in">
    <div class="section-head"><h2>Open now</h2><a href="#/hours">All branches →</a></div>
    ${open.length
      ? html`<div class="branch-mini">${open.map(({ b, st }) => html`<a href="#/hours?b=${encodeURIComponent(shortBranch(b.name))}">${shortBranch(b.name)}<span class="until">until ${fmtTime(st.until)}</span></a>`)}</div>`
      : html`<p class="muted">Every branch is closed right now.</p>`}
  </section>`;
}

// ---- Search ---------------------------------------------------------------------

const EXAMPLES = [["Louise Penny", "author"], ["Gardening", "subject"], ["Large print mysteries", "keyword"], ["Canadian history", "subject"], ["Graphic novels", "keyword"]];

async function searchPage(params) {
  const q = params.get("q") ?? "";
  const index = params.get("index") ?? "keyword";
  const sort = params.get("sort") ?? "relevance";
  const branch = params.get("branch") ?? "";
  const page = Number(params.get("page") ?? 1);
  render(html`
    <div class="search-head">${searchForm("searchform", { q, index, branch: q ? branch : savedBranch(), autofocus: !q })}</div>
    <div id="results">${q
      ? html`<div style="margin-top:28px">${skeleton(4, 110)}</div>`
      : html`<div class="empty"><h2>What are you looking for?</h2><p>Books, large print, DVDs, audiobooks and more.</p>
          <div class="chips" style="justify-content:center;flex-wrap:wrap;margin-top:18px">${EXAMPLES.map(([t, i]) => html`<a class="chip" href="${searchHref(t, i)}">${t}</a>`)}</div></div>`}</div>`);
  wireSearchForm($("#searchform"), () => (sort !== "relevance" ? { sort } : {}));
  if (!q) return;

  try {
    const [r, cfg] = await Promise.all([
      api(`/search?${new URLSearchParams({ q, index, sort, page, limit: 20, ...(branch && { branch }) })}`),
      getConfig().catch(() => ({})),
    ]);
    if (!r.hits.length) {
      fill($("#results"), html`<div class="empty"><h2>No results for “${q}”</h2><p>Try fewer words${index !== "keyword" ? html`, or <a href="${searchHref(q, "keyword", { branch })}">search everything</a>` : ""}${branch ? html`, or <a href="${searchHref(q, index, { branch: "" })}" data-all-branches>search all branches</a>` : ""}.</p></div>`);
      return;
    }
    const pageHref = (p) => searchHref(q, index, { branch, ...(sort !== "relevance" && { sort }), page: p });
    fill($("#results"), html`<div class="fade-in">
      <div class="results-head">
        <h2>${r.total.toLocaleString()} ${r.total === 1 ? "result" : "results"}${branchName(cfg, branch) ? html` <span class="muted" style="font-weight:500">at ${branchName(cfg, branch)}</span>` : ""}</h2>
        <select class="select bare" id="sort" aria-label="Sort results">${options(SORTS, sort)}</select>
      </div>
      <div class="hits">${r.hits.map((h) => hitCard(h, { save: cfg.hasCredentials, branch }))}</div>
      ${pager(r.page, r.totalPages, pageHref)}</div>`);
    $("#sort").addEventListener("change", (e) => { location.hash = searchHref(q, index, { branch, ...(e.target.value !== "relevance" && { sort: e.target.value }) }); });
  } catch (e) {
    fill($("#results"), html`<div style="margin-top:24px">${errorBox(e)}</div>`);
  }
}

const branchName = (cfg, code) => (code ? shortBranch(cfg.branches?.find((b) => b.code === code)?.name) : "");

// Vega sends codes like "CheckedOut" and "CheckAvailability": "Checked out", "Check availability".
const statusLabel = (s) => (s ?? "").replace(/([a-z])([A-Z])/g, (_, a, b) => `${a} ${b.toLowerCase()}`);
const statusTone = (label) => (/^available/i.test(label) ? "ok" : /checked out|on order|unavailable|in process|transit|hold/i.test(label) ? "warn" : "");

// branch: with the branch filter on, say how this format stands there when the hit lists it.
function formatChip(f, branch) {
  const name = formatName(f.format);
  if (f.electronic) return html`<span class="fmt libby" title="Borrow it in the Libby app"><span class="dot"></span>${name}<span class="s">Libby</span></span>`;
  const here = branch && f.branches?.filter((b) => b.code === branch);
  let label = statusLabel(f.status);
  let tone = statusTone(label);
  const inBranches = f.branches?.filter((b) => b.available) ?? [];
  let s = tone === "ok" && inBranches.length ? `at ${inBranches.length}${f.moreBranches ? "+" : ""} ${inBranches.length === 1 ? "branch" : "branches"}` : label;
  // With the branch filter on, results list that branch for every format it holds.
  if (here?.length) {
    const avail = here.some((b) => b.available);
    tone = avail ? "ok" : "warn";
    s = `${avail ? "at" : "out at"} ${shortBranch(here[0].name)}`;
  } else if (branch && f.branches?.length) {
    tone = "";
    s = "not at this branch";
  }
  const title = inBranches.length ? `On the shelf at ${inBranches.map((b) => shortBranch(b.name)).join(", ")}` : "";
  const inner = html`<span class="dot${tone ? "" : " none"}"></span>${name}${s ? html`<span class="s">${s}</span>` : ""}`;
  const ed = f.editions[0];
  return ed
    ? html`<a class="fmt ${tone}" href="#/record/${ed.recordId}" title="${title}">${inner}</a>`
    : html`<span class="fmt ${tone}" title="${title}">${inner}</span>`;
}

// opts.save: show a save button (needs a card); opts.removeFrom: a list id to show "Remove" for.
function hitCard(hit, opts = {}) {
  const first = hit.recordId ?? hit.formats.flatMap((f) => f.editions)[0]?.recordId;
  const href = first ? `#/record/${first}` : null;
  const item = { formatGroupId: hit.id, recordId: first, title: cleanTitle(hit.title) };
  const side = opts.removeFrom
    ? html`<button class="btn sm quiet danger" data-list-remove="${opts.removeFrom}" data-item="${JSON.stringify(item)}">Remove</button>`
    : opts.save && hit.id ? html`<button class="btn icon quiet" data-save="${JSON.stringify(item)}" aria-label="Save ${item.title} to a list" title="Save to a list">${raw(icon.bookmark)}</button>` : "";
  const art = cover(hit.title, hit.author, { isbn: hit.isbn, src: hit.cover });
  return html`<article class="hit">
    ${href ? html`<a href="${href}" aria-hidden="true" tabindex="-1">${art}</a>` : html`<div>${art}</div>`}
    <div>
      <h3>${href ? html`<a href="${href}">${cleanTitle(hit.title)}</a>` : cleanTitle(hit.title)}</h3>
      <p class="by">${[prettyName(hit.author), hit.year].filter(Boolean).join(" · ")}</p>
      <div class="formats">${hit.formats.map((f) => formatChip(f, opts.branch))}</div>
    </div>
    <div class="side">${side}</div>
  </article>`;
}

// ---- Record -----------------------------------------------------------------------

async function recordPage(id) {
  const back = html`<a class="back" href="#/search" data-back>${raw(icon.back)} Back</a>`;
  render(html`${back}<div class="record"><div class="skeleton record-cover" style="aspect-ratio:2/3"></div>${skeleton(3, 60)}</div>`);
  let rec;
  try {
    rec = await api(`/records/${encodeURIComponent(id)}`);
  } catch (e) {
    render(html`${back}${errorBox(e)}`);
    return;
  }
  document.title = `${cleanTitle(rec.title)} · Library Helper`;
  const authors = (rec.contributors ?? []).filter((c) => !c.role || c.role === "aut").slice(0, 3);
  const cfg = await getConfig().catch(() => ({}));
  const meta = [
    ["Edition", rec.edition],
    ["Published", rec.published ?? rec.year],
    ["Length", rec.extent?.replace(/\s*[:;,/]\s*$/, "")],
    ["Call number", rec.callNumber],
    ["Language", languageName(rec.language)],
    ["ISBN", rec.isbn?.[0]],
  ].filter(([, v]) => v);
  const long = (rec.summary?.length ?? 0) > 420;
  render(html`${back}
    <div class="record fade-in">
      <div class="record-cover">${cover(rec.title, authors[0]?.name, { size: "lg", isbn: rec.isbn?.[0], src: rec.cover })}</div>
      <div class="stack">
        <div>
          <p class="eyebrow">${[formatName(rec.format), rec.year].filter(Boolean).join(" · ")}</p>
          <h1>${cleanTitle(rec.title)}</h1>
          ${authors.length ? html`<p class="byline">by ${authors.map((c, i) => html`${i ? ", " : ""}<a href="${searchHref(c.name.replace(/[.,]$/, ""), "author")}">${prettyName(c.name)}</a>`)}</p>` : ""}
        </div>
        <div id="avail" class="availability"><span class="dot" style="color:var(--faint)"></span><span class="muted">Checking the shelves…</span></div>
        ${cfg.hasCredentials ? html`<div class="actions">
          <button class="btn primary" id="hold-btn">Place hold</button>
          <button class="btn" data-save="${JSON.stringify({ formatGroupId: rec.formatGroupId, recordId: rec.recordId, title: cleanTitle(rec.title) })}">${raw(icon.bookmark)} Save</button>
        </div>` : ""}
        ${rec.summary ? html`<div><p class="summary${long ? " clamp" : ""}" id="summary">${rec.summary}</p>${long ? html`<button class="read-more" id="more" aria-expanded="false">Read more</button>` : ""}</div>` : ""}
        ${meta.length ? html`<dl class="meta">${meta.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : ""}
        <div id="copies"></div>
        ${rec.otherFormats?.length ? html`<div><p class="label">Other formats &amp; editions</p><div class="editions">${rec.otherFormats.map((f) => html`<a href="#/record/${f.recordId}">${formatName(f.format)}<span>${f.year ?? "Edition"}</span></a>`)}</div></div>` : ""}
        ${rec.subjects?.length ? html`<div><p class="label">Subjects</p><div class="tags">${rec.subjects.map((s) => html`<a href="${searchHref(s.replace(/--/g, " "), "subject")}">${s.replace(/--/g, " › ")}</a>`)}</div></div>` : ""}
      </div>
    </div>`);
  $("#hold-btn")?.addEventListener("click", () => holdDialog(rec));
  $("#more")?.addEventListener("click", (e) => {
    const clamped = $("#summary").classList.toggle("clamp");
    e.target.textContent = clamped ? "Read more" : "Show less";
    e.target.setAttribute("aria-expanded", String(!clamped));
  });

  const avail = $("#avail");
  try {
    const copies = await api(`/records/${encodeURIComponent(id)}/availability`);
    copies.sort((a, b) => Number(b.available) - Number(a.available) || (a.branch ?? "").localeCompare(b.branch ?? ""));
    const inBranches = [...new Set(copies.filter((c) => c.available).map((c) => shortBranch(c.branch)))];
    const nextDue = copies.map((c) => c.dueDate).filter(Boolean).sort((a, b) => toDate(a) - toDate(b))[0];
    if (!copies.length) {
      fill(avail, html`<span class="dot" style="color:var(--accent)"></span><span>No physical copies. This may be a Libby title.</span>`);
    } else if (inBranches.length) {
      avail.classList.add("ok");
      fill(avail, html`<span class="dot"></span><span><strong>On the shelf</strong> at ${listJoin(inBranches)}</span>`);
    } else {
      avail.classList.add("warn");
      fill(avail, html`<span class="dot"></span><span><strong>${copies.length === 1 ? "The only copy is out" : `All ${copies.length} copies are out`}</strong>${nextDue ? ` · next due back ${fmtDay(nextDue)}` : ""}</span>`);
    }
    if (copies.length) fill($("#copies"), html`<div>
      <p class="label">${copies.length === 1 ? "1 copy" : `${copies.length} copies`}</p>
      <div class="panel rows">${copies.map((c) => html`<div class="copy">
        <span class="where">${c.branch}${c.volume ? html` <span class="muted small">${c.volume}</span>` : ""}</span>
        <span class="state"><span class="tag ${c.available ? "ok" : "warn"}"><span class="dot"></span>${c.status}</span>${c.dueDate ? html`<span class="muted">due ${fmtDay(c.dueDate)}</span>` : ""}</span>
        <span class="call">${c.callNumber}</span>
      </div>`)}</div></div>`);
  } catch (e) {
    fill(avail, html`<span class="muted">${e.message}</span>`);
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
  fill(dlg, html`<form method="dialog">
    <div><h2>Place a hold</h2><p class="sub">${cleanTitle(rec.title)}${rec.format ? ` · ${formatName(rec.format)}` : ""}</p></div>
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
      if (btn) btn.textContent = "Hold placed";
      refreshBadge();
    } catch (e) {
      toast(e.message, "bad");
      if (btn) btn.disabled = false;
    }
  }, { once: true });
}

// ---- Borrowed, Lists, Account ---------------------------------------------------
// Three pages over the patron's card: what's borrowed or on the way, the reading
// lists they keep, and the account record (fines, history).

const PAGES = {
  borrowed: { title: "Borrowed", tabs: [["loans", "Checked out", loansTab], ["holds", "Holds", holdsTab]] },
  lists: { title: "Lists", tabs: [["", "Lists", listsTab]] },
  account: { title: "Account", tabs: [["fines", "Fines", finesTab], ["history", "History", historyTab]], cardMeta: true },
};

// Old #/account/<tab> links from before the split.
const MOVED = { loans: "#/borrowed/loans", holds: "#/borrowed/holds", lists: "#/lists" };

async function patronPage(section, tab) {
  const page = PAGES[section];
  const current = page.tabs.find(([k]) => k === tab) ?? page.tabs[0];
  const cfg = await getConfig().catch((e) => ({ error: e }));
  if (cfg.error) return render(errorBox(cfg.error));
  if (!cfg.hasCredentials) {
    render(html`<div class="page-head"><div><h1>${page.title}</h1></div></div>${signInPanel()}`);
    wireSignIn();
    return;
  }
  render(html`
    <div class="page-head"><div><h1>${page.title}</h1>${page.cardMeta ? html`<p class="sub" id="card-meta">&nbsp;</p>` : ""}</div>
      ${page.cardMeta ? html`<button class="btn sm" id="signout">Sign out${cfg.card ? ` of ${cfg.card}` : ""}</button>` : ""}</div>
    ${page.tabs.length > 1 ? html`<nav class="chips tabs" aria-label="${page.title}">${page.tabs.map(([k, l]) => html`<a class="chip" href="#/${section}/${k}" ${raw(k === current[0] ? 'aria-current="page"' : "")} data-tab="${k}">${l}</a>`)}</nav>` : ""}
    <div id="tab">${skeleton(3, 72)}</div>`);

  $("#signout")?.addEventListener("click", signOut);
  getAccount().then((s) => {
    const meta = $("#card-meta");
    if (meta) meta.textContent = [cfg.card, s.homeLibrary, s.cardExpires && `Card expires ${fmtDate(s.cardExpires)}`].filter(Boolean).join(" · ");
    setTabInfo("loans", s.loans, s.overdue ? "bad" : "");
    setTabInfo("holds", s.holds, s.holdsReadyForPickup ? "ok" : "");
    if (s.moneyOwed > 0) setTabInfo("fines", money.format(s.moneyOwed), "bad");
    updateBadge(s);
  }).catch(() => {});

  const el = $("#tab");
  try {
    await current[2](el);
    el.classList.add("fade-in");
  } catch (e) {
    fill(el, errorBox(e));
  }
}

// Adds a count (and a coloured dot when something needs attention) to a tab chip.
function setTabInfo(k, n, alert = "") {
  const a = $(`[data-tab="${k}"]`);
  if (!a) return;
  $$(".n, .alert", a).forEach((x) => x.remove());
  a.insertAdjacentHTML("beforeend", String(html`<span class="n">${n}</span>${alert ? html`<span class="alert ${alert}"></span>` : ""}`));
}

async function loansTab(el) {
  const loans = await api("/loans");
  if (!loans.length) {
    fill(el, emptyState("Nothing checked out", "Find something good to read.", searchCta));
    return;
  }
  loans.sort((a, b) => toDate(a.dueDate) - toDate(b.dueDate));
  const renewable = loans.filter((l) => l.canRenew);
  fill(el, html`
    <div class="toolbar">
      <span class="muted">${plural(loans.length, "item")}, soonest due first</span>
      ${renewable.length > 1 ? html`<button class="btn sm" id="renew-all">${raw(icon.refresh)} Renew all ${renewable.length}</button>` : ""}
    </div>
    <div class="panel rows">${loans.map((l) => {
      const due = relDue(l.dueDate);
      return html`<div class="item">
        <span>${cover(l.title, undefined, { size: "xs", src: l.cover })}</span>
        <div>
          <div class="title">${cleanTitle(l.title)}</div>
          <div class="sub">
            ${l.format ? html`<span>${formatName(l.format)}</span>` : ""}
            ${l.source !== "library" ? html`<span title="${l.note ?? ""}">Libby: renew in the app</span>` : ""}
            ${l.renewalLimit != null ? html`<span>Renewed ${l.renewals ?? 0} of ${l.renewalLimit}</span>` : ""}
          </div>
        </div>
        <div class="end">
          <span class="tag ${due.tone}">${due.text}</span>
          ${l.canRenew ? html`<button class="btn sm" data-renew="${l.checkoutId}">Renew</button>` : ""}
        </div>
      </div>`;
    })}</div>`);

  const renew = async (ids, btn) => {
    btn.disabled = true;
    try {
      const results = await api("/loans/renew", { method: "POST", body: { checkoutIds: ids } });
      const ok = results.filter((r) => r.renewed).length;
      if (ok) toast(`Renewed ${plural(ok, "item")}.`);
      for (const f of results.filter((r) => !r.renewed)) toast(`Couldn't renew: ${f.reason}`, "bad");
      route();
      refreshBadge();
    } catch (e) {
      toast(e.message, "bad");
      btn.disabled = false;
    }
  };
  $("#renew-all", el)?.addEventListener("click", (e) => renew(renewable.map((l) => l.checkoutId), e.currentTarget));
  $$("[data-renew]", el).forEach((b) => b.addEventListener("click", () => renew([b.dataset.renew], b)));
}

async function holdsTab(el) {
  const holds = await api("/holds");
  if (!holds.length) {
    fill(el, emptyState("No holds", "Place a hold from any title's page and it'll show up here.", searchCta));
    return;
  }
  holds.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0));
  const ready = holds.filter((h) => h.readyForPickup);
  const waiting = holds.filter((h) => !h.readyForPickup);
  const row = (h) => {
    const title = cleanTitle(h.title);
    const art = cover(h.title, undefined, { size: "xs", src: h.cover });
    return html`<div class="item">
      ${h.recordId ? html`<a class="cover-link" href="#/record/${h.recordId}" tabindex="-1" aria-hidden="true">${art}</a>` : html`<span>${art}</span>`}
      <div>
        <div class="title">${h.recordId ? html`<a href="#/record/${h.recordId}">${title}</a>` : title}</div>
        <div class="sub">
          ${h.format ? html`<span>${formatName(h.format)}</span>` : ""}
          ${h.pickupLocation ? html`<span>${shortBranch(h.pickupLocation.name)}</span>` : ""}
          ${h.readyForPickup && h.expires ? html`<span>Pick up by ${fmtDay(h.expires)}</span>` : ""}
          ${!h.readyForPickup && h.queuePosition != null ? html`<span>#${h.queuePosition} in line</span>` : ""}
          ${h.frozen ? html`<span>Paused</span>` : ""}
        </div>
      </div>
      <div class="end">
        ${h.readyForPickup ? html`<span class="tag ok"><span class="dot"></span>Ready</span>` : h.status === "in transit" ? html`<span class="tag accent">In transit</span>` : ""}
        <button class="btn sm quiet danger" data-cancel="${h.holdId}" data-title="${title}">Cancel</button>
      </div>
    </div>`;
  };
  fill(el, html`<div class="panel rows">
    ${ready.length ? html`<div class="group-head">Ready for pickup<span>${ready.length}</span></div>${ready.map(row)}` : ""}
    ${waiting.length ? html`<div class="group-head">Waiting<span>${waiting.length}</span></div>${waiting.map(row)}` : ""}
  </div>`);
  $$("[data-cancel]", el).forEach((b) => b.addEventListener("click", async () => {
    if (!(await confirmDialog(`Cancel your hold on “${b.dataset.title}”?`, "You'll lose your place in line. This can't be undone.", "Cancel hold"))) return;
    b.disabled = true;
    try {
      const [r] = await api("/holds/cancel", { method: "POST", body: { holdIds: [b.dataset.cancel] } });
      if (r?.cancelled) toast("Hold cancelled.");
      else toast(`Couldn't cancel: ${r?.reason ?? "unknown error"}`, "bad");
      route();
      refreshBadge();
    } catch (e) {
      toast(e.message, "bad");
      b.disabled = false;
    }
  }));
}

function confirmDialog(title, body, action) {
  const dlg = $("#dialog");
  fill(dlg, html`<form method="dialog">
    <div><h2>${title}</h2><p class="sub">${body}</p></div>
    <div class="actions"><button class="btn" value="no">Keep it</button><button class="btn primary" value="yes">${action}</button></div>
  </form>`);
  dlg.showModal();
  return new Promise((resolve) => dlg.addEventListener("close", () => resolve(dlg.returnValue === "yes"), { once: true }));
}

// ---- Reading lists ------------------------------------------------------------------

const LIST_SORTS = [["date.desc", "Newest first"], ["date.asc", "Oldest first"], ["title.asc", "Title A–Z"], ["title.desc", "Title Z–A"]];

async function listsTab(el) {
  const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
  const [lists, cfg] = await Promise.all([api("/lists"), getConfig()]);
  if (!lists.length) {
    fill(el, emptyState("No lists yet", "Save titles from search results to start a reading list."));
    return;
  }
  // Default to the first list with something on it, preferring the patron's own lists.
  const current = lists.find((l) => l.listId === params.get("list")) ?? lists.find((l) => l.count && l.type === "regular") ?? lists.find((l) => l.count) ?? lists[0];
  const sort = LIST_SORTS.some(([k]) => k === params.get("sort")) ? params.get("sort") : "date.desc";
  const page = Number(params.get("page")) || 1;
  const at = cfg.branches.some((b) => b.code === params.get("at")) ? params.get("at") : "";
  const href = (o) => `#/lists?${new URLSearchParams({ list: current.listId, sort, ...(at && { at }), ...o })}`;
  fill(el, html`
    <div class="toolbar">
      <div class="chips" aria-label="Lists">${lists.map((l) => html`<a class="chip" ${raw(l === current ? 'aria-current="page"' : "")} href="#/lists?${new URLSearchParams({ list: l.listId, sort, ...(at && { at }) })}">${l.name}<span class="n">${l.count}</span></a>`)}</div>
      <div class="row" style="gap:8px">
        <label class="branch-filter${at ? " on" : ""}" title="Only titles with a copy on the shelf at this branch now">${raw(icon.pin)}<span class="prefix">On the shelf at</span>
          <select class="select bare" id="list-at"><option value="">any branch</option>${cfg.branches.map((b) => html`<option value="${b.code}"${raw(b.code === at ? " selected" : "")}>${shortBranch(b.name)}</option>`)}</select>
        </label>
        <select class="select bare" id="list-sort" aria-label="Sort list">${options(LIST_SORTS, sort)}</select>
      </div>
    </div>
    <div id="list-items">${skeleton(2, 110)}</div>`);
  $("#list-sort", el).addEventListener("change", (e) => { location.hash = href({ sort: e.target.value }); });
  $("#list-at", el).addEventListener("change", (e) => {
    const p = new URLSearchParams({ list: current.listId, sort, ...(e.target.value && { at: e.target.value }) });
    location.hash = `#/lists?${p}`;
  });
  if (!current.count) {
    fill($("#list-items", el), emptyState("Nothing saved here yet", "Use the bookmark on a search result or title page to add it."));
    return;
  }
  const r = await api(`/lists/${current.listId}/items?${new URLSearchParams({ sort, page, limit: 50, ...(at && { availableAt: at }) })}`);
  const where = at ? branchName(cfg, at) : "";
  if (!r.items.length && at) {
    fill($("#list-items", el), emptyState(`Nothing on the shelf at ${where}`, "Nothing from this list is in right now. Try another branch.", html`<a class="btn" href="#/lists?${new URLSearchParams({ list: current.listId, sort })}">Show the whole list</a>`));
    return;
  }
  fill($("#list-items", el), html`
    ${at ? html`<p class="muted small" style="margin-bottom:4px">${plural(r.total ?? r.items.length, "title")} on the shelf at ${where}${current.count > 200 ? " (first 200 on the list checked)" : ""}</p>` : ""}
    <div class="hits">${r.items.map((h) => hitCard(h, { removeFrom: current.listId, branch: at }))}</div>${pager(r.page, r.totalPages, (p) => href({ page: p }))}`);
}

async function updateList(item, add, remove) {
  return api("/lists/items", { method: "POST", body: { ...item, add, remove } });
}

// Pick which lists a title is on. Ticks start from where it is now; saving sends the difference.
async function saveDialog(item) {
  const dlg = $("#dialog");
  fill(dlg, html`<form method="dialog">
    <div><h2>Save to a list</h2><p class="sub">${item.title}</p></div>
    <div id="list-choices">${skeleton(2, 46)}</div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="ok" disabled>Save</button></div>
  </form>`);
  dlg.showModal();
  let state;
  try {
    state = await api(`/lists/containing?${new URLSearchParams({ id: item.formatGroupId })}`);
  } catch (e) {
    fill($("#list-choices", dlg), errorBox(e));
    return;
  }
  const on = new Set(state.containing);
  fill($("#list-choices", dlg), html`<div class="choices">${state.lists.map((l) => html`
    <label class="choice"><input type="checkbox" class="check" name="list" value="${l.listId}" ${raw(on.has(l.listId) ? "checked" : "")}>${l.name}<span class="n">${plural(l.count, "title")}</span></label>`)}</div>`);
  // Nothing ticked yet: pre-tick the first own list so one click saves.
  if (!on.size) {
    const def = state.lists.find((l) => l.type === "regular") ?? state.lists[0];
    const box = def && $(`input[value="${def.listId}"]`, dlg);
    if (box) box.checked = true;
  }
  $('button[value="ok"]', dlg).disabled = false;
  dlg.addEventListener("close", async () => {
    if (dlg.returnValue !== "ok") return;
    const ticked = new Set($$('input[name="list"]:checked', dlg).map((b) => b.value));
    const add = [...ticked].filter((id) => !on.has(id));
    const remove = [...on].filter((id) => !ticked.has(id));
    if (!add.length && !remove.length) return;
    const names = (ids) => ids.map((id) => state.lists.find((l) => l.listId === id)?.name).join(", ");
    try {
      await updateList(item, add, remove);
      toast([add.length && `Saved to ${names(add)}.`, remove.length && `Removed from ${names(remove)}.`].filter(Boolean).join(" "));
    } catch (e) {
      toast(e.message, "bad");
    }
  }, { once: true });
}

document.addEventListener("click", async (e) => {
  if (e.target.closest?.("[data-all-branches]")) store.set("branch", "");
  const save = e.target.closest?.("[data-save]");
  if (save) {
    e.preventDefault();
    saveDialog(JSON.parse(save.dataset.save));
    return;
  }
  const rm = e.target.closest?.("[data-list-remove]");
  if (rm) {
    e.preventDefault();
    const item = JSON.parse(rm.dataset.item);
    rm.disabled = true;
    try {
      await updateList(item, [], [rm.dataset.listRemove]);
      toast(`Removed ${item.title}.`);
      route();
    } catch (err) {
      toast(err.message, "bad");
      rm.disabled = false;
    }
  }
});

async function finesTab(el) {
  const f = await api("/fines");
  if (!f.fines.length) {
    fill(el, emptyState("All clear", "No fines or fees on this card."));
    return;
  }
  fill(el, html`<div class="panel rows">
    <div class="total"><span class="muted">Total owed</span><span class="amount">${money.format(f.totalOutstanding)}</span></div>
    ${f.fines.map((x) => html`<div class="item plain">
      <div>
        <div class="title">${cleanTitle(x.title) || x.description || "Charge"}</div>
        <div class="sub">${x.type ? html`<span>${x.type}</span>` : ""}${x.date ? html`<span>${fmtDate(x.date)}</span>` : ""}${x.title && x.description ? html`<span>${x.description}</span>` : ""}</div>
      </div>
      <div class="end"><strong style="font-variant-numeric:tabular-nums">${money.format(x.amount)}</strong></div>
    </div>`)}
  </div>`);
}

async function historyTab(el) {
  const h = await api("/history");
  if (!h.enabled) {
    fill(el, emptyState("Reading history is off", h.message));
    return;
  }
  if (!h.items.length) {
    fill(el, emptyState("No history yet", "Books you borrow will show up here."));
    return;
  }
  fill(el, html`<div class="toolbar"><span class="muted">${plural(h.total, "book")} borrowed</span></div>
    <div class="panel rows">${h.items.map((x) => {
      const title = cleanTitle(x.title);
      const href = x.recordId ? `#/record/${x.recordId}` : searchHref(title, "title");
      return html`<div class="item">
        <a class="cover-link" href="${href}" tabindex="-1" aria-hidden="true">${cover(x.title, x.author, { size: "xs", src: x.cover })}</a>
        <div><div class="title"><a href="${href}">${title}</a></div>
          <div class="sub">${x.author ? html`<span>${prettyName(x.author)}</span>` : ""}${x.format ? html`<span>${formatName(x.format)}</span>` : ""}</div></div>
        <div class="end muted small">${fmtDay(x.checkedOut)}</div>
      </div>`;
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

// "10AM - 3PM" -> "10 AM – 3 PM"
const fmtTime = (t) => (t ?? "").replace(/(\d)\s*([AP]M)\b/gi, "$1 $2");
const fmtRange = (r) => fmtTime(r).replace(/\s+-\s+/, " – ");

function openState(b, today) {
  const range = b.hours?.[today.weekday];
  if (b.note || !range) return { open: false, closedToday: !range };
  const [from, to] = range.split(" - ");
  const [hh, mm] = today.time.split(":").map(Number);
  const now = hh * 60 + mm, start = minutes(from ?? ""), end = minutes(to ?? "");
  if (start == null || end == null) return { open: false };
  return { open: now >= start && now < end, until: to, opensAt: now < start ? from : null };
}

async function hoursPage(params) {
  render(html`<div class="page-head">
      <div><h1>Branches &amp; hours</h1><p class="sub" id="today">&nbsp;</p></div>
      <input class="input" id="bfilter" type="search" placeholder="Find a branch" aria-label="Find a branch" value="${params.get("b") ?? ""}">
    </div>
    <div id="hours" style="margin-top:24px">${skeleton(6, 52)}</div>`);
  let h;
  try {
    h = await api("/hours");
  } catch (e) {
    fill($("#hours"), errorBox(e));
    return;
  }
  // Open now, then opening later today, then the rest; alphabetical within each.
  const rank = (st) => (st.open ? 0 : st.opensAt ? 1 : 2);
  const branches = h.branches.map((b) => ({ b, st: openState(b, h.today) }))
    .sort((x, y) => rank(x.st) - rank(y.st) || x.b.name.localeCompare(y.b.name));
  const openCount = branches.filter((x) => x.st.open).length;
  $("#today").textContent = `${capitalize(h.today.weekday)} · ${openCount ? `${plural(openCount, "branch")} open now` : "All branches closed now"}`;
  const draw = () => {
    const f = $("#bfilter").value.trim().toLowerCase();
    const list = branches.filter(({ b }) => !f || b.name.toLowerCase().includes(f));
    fill($("#hours"), html`
      ${list.length ? html`<div class="panel rows">${list.map(({ b, st }) => {
        const tag = b.note ? html`<span class="tag bad">${b.note}</span>`
          : st.open ? html`<span class="tag ok"><span class="dot"></span>Open until ${fmtTime(st.until)}</span>`
          : st.opensAt ? html`<span class="tag warn">Opens ${fmtTime(st.opensAt)}</span>`
          : html`<span class="tag">${st.closedToday ? "Closed today" : "Closed now"}</span>`;
        const todays = b.hours?.[h.today.weekday];
        return html`<details class="branch" ${raw(list.length === 1 ? "open" : "")}>
          <summary>
            <span class="name">${shortBranch(b.name)}</span>
            <span class="today-hours">${!b.note && todays ? `Today ${fmtRange(todays)}` : ""}</span>
            ${tag}
            ${raw(icon.chev)}
          </summary>
          <div class="detail">
            <div class="week">${WEEK.map((d) => {
              const cls = [d === h.today.weekday && "today", !b.hours[d] && "closed"].filter(Boolean).join(" ");
              return html`<span class="d ${cls}">${d.slice(0, 3)}</span><span class="${cls}">${b.hours[d] ? fmtRange(b.hours[d]) : "Closed"}</span>`;
            })}</div>
            <div class="contact">
              ${b.address ? html`<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(b.address)}" target="_blank" rel="noopener">${raw(icon.pin)}<span>${b.address}</span></a>` : ""}
              ${b.phone ? html`<a href="tel:${b.phone.replace(/[^\d+]/g, "")}">${raw(icon.phone)}<span>${b.phone}</span></a>` : ""}
              ${b.url ? html`<a href="${b.url}" target="_blank" rel="noopener">${raw(icon.link)}<span>Branch page</span></a>` : ""}
            </div>
          </div>
        </details>`;
      })}</div>` : html`<div class="panel empty">No branch matches “${f}”.</div>`}
      <p class="muted small" style="margin-top:16px">From <a href="${h.source}" target="_blank" rel="noopener">the library website</a>. Holiday closures aren't listed.</p>`);
  };
  $("#bfilter").addEventListener("input", draw);
  draw();
}

// ---- Router -----------------------------------------------------------------

function updateBadge(s) {
  const b = $("#nav-badge");
  if (!b) return;
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
  if (section === "account" && MOVED[parts[1]]) {
    history.replaceState(null, "", `${MOVED[parts[1]]}${query ? `?${query}` : ""}`);
    return route();
  }
  $$("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === section || (section === "record" && a.dataset.nav === "search");
    a.classList.toggle("active", on);
    if (on) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  $("#topsearch").hidden = section === "" || section === "search";
  const titles = { search: params.get("q") ? `${params.get("q")} – Search` : "Search", borrowed: "Borrowed", lists: "Lists", account: "Account", hours: "Hours", record: "Title" };
  document.title = titles[section] ? `${titles[section]} · Library Helper` : "Library Helper";

  if (section === "search") await searchPage(params);
  else if (section === "record" && parts[1]) await recordPage(parts[1]);
  else if (PAGES[section]) await patronPage(section, parts[1]);
  else if (section === "hours") await hoursPage(params);
  else await homePage();
}

$("#topsearch").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = e.target.q.value.trim();
  if (q) { location.hash = searchHref(q); e.target.q.value = ""; e.target.q.blur(); }
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
// "/" jumps to the search box from anywhere.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "")) return;
  const input = [$("#bigsearch input[name=q]"), $("#searchform input[name=q]"), $("#topsearch input")].find((x) => x?.offsetParent);
  if (input) { e.preventDefault(); input.focus(); }
});
lastPath = location.hash.split("?")[0];
route();
refreshBadge();
