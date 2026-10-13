// Client for an Infor Iguana 6.5 OPAC (reverse-engineered from the site's own JS).
//
// Two backends sit behind the web UI:
//   - Proxy.SearchRequest.cls: form-encoded POST, returns SRU-like XML. Catalogue search,
//     full records and item holdings. Works anonymously.
//   - Rest.Server.cls?sessionId=<rest token>&method=user/<action>: JSON POST, returns
//     {"response": ...}. Patron account; needs the sessionId returned by user/credentials.
//
// Both require the CSP session cookie and a same-origin Referer header; without the
// Referer the server answers 200 with an empty body.

import { parseSearchResponse, parseRecord, parseHoldings } from "./parse.ts";
import type { SearchResult, SearchHit, ClusterVersion, RecordDetail, HoldingItem } from "./parse.ts";

export interface IguanaConfig {
  baseUrl: string; // e.g. https://catalogue.lclibrary.ca/iguana/
  profile: string; // Config.gen_sys_woprofile
  cardNumber?: string;
  pin?: string;
}

export class IguanaError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

const SESSION_TTL_MS = 10 * 60 * 1000; // server timeout is 900s; refresh well before

const SEARCH_DEFAULTS = {
  fu: "BibSearch",
  Language: "eng",
  Namespace: "0",
  Application: "Bib",
  Database: "1",
};

export const SEARCH_INDEXES = {
  keyword: "1*Keywordsbib",
  title: "1*Titlebib",
  title_exact: "1*Fulltitle",
  author: "1*Authorbib$",
  subject: "1*Subjectbib$",
  series: "1*Seriesbib$",
  isbn: "1*Isbn",
} as const;
export type SearchIndex = keyof typeof SEARCH_INDEXES;

export class IguanaClient {
  private readonly cfg: IguanaConfig;
  private cookies = new Map<string, string>();
  private cspSid = ""; // SIDTKN / CspSessionId
  private restToken = ""; // sessionId in Rest.Server.cls URLs
  private sessionStartedAt = 0;
  private patronSessionId = ""; // Data.User.sessionId after login
  private patron: Record<string, unknown> | null = null;
  // In-flight session/login, shared so concurrent calls don't each start their own.
  private pending = new Map<string, Promise<void>>();

  constructor(cfg: IguanaConfig) {
    this.cfg = { ...cfg, baseUrl: cfg.baseUrl.endsWith("/") ? cfg.baseUrl : cfg.baseUrl + "/" };
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private url(path: string): string {
    return new URL(path, this.cfg.baseUrl).toString();
  }

  private async http(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<string> {
    const headers: Record<string, string> = {
      Referer: this.url("www.main.cls"),
      "User-Agent": "Mozilla/5.0 (library-helper MCP)",
    };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    if (init.contentType) headers["Content-Type"] = init.contentType;
    const res = await fetch(this.url(path), { method: init.method ?? "GET", headers, body: init.body, redirect: "follow" });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    if (!res.ok) throw new IguanaError("HttpError", `${res.status} ${res.statusText} for ${path}`);
    return res.text();
  }

  private once(key: string, fn: () => Promise<void>): Promise<void> {
    let p = this.pending.get(key);
    if (!p) {
      p = fn().finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    return p;
  }

  private ensureSession(): Promise<void> {
    if (this.cspSid && Date.now() - this.sessionStartedAt < SESSION_TTL_MS) return Promise.resolve();
    return this.once("session", () => this.startSession());
  }

  private async startSession(): Promise<void> {
    this.cookies.clear();
    this.patronSessionId = "";
    this.patron = null;
    const html = await this.http("www.main.cls");
    const sid = html.match(/sessionID = '([^']+)'/)?.[1];
    if (!sid) throw new IguanaError("NoSession", "could not find sessionID in www.main.cls");
    this.cspSid = sid;
    const settings = await this.http(`www.jsSettings.cls?t=${Date.now()}&SIDTKN=${sid}`);
    const token = settings.match(/Rest\.Server\.cls\?sessionId=([^&"']+)/)?.[1];
    if (!token) throw new IguanaError("NoSession", "could not find REST sessionId in jsSettings");
    this.restToken = token;
    this.sessionStartedAt = Date.now();
  }

  private async searchRequest(params: Record<string, string | number>): Promise<string> {
    await this.ensureSession();
    const body = new URLSearchParams({
      ...SEARCH_DEFAULTS,
      Profile: this.cfg.profile,
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      CspSessionId: this.cspSid,
      SIDTKN: this.cspSid,
    });
    const xml = await this.http("Proxy.SearchRequest.cls", {
      method: "POST",
      body: body.toString(),
      contentType: "application/x-www-form-urlencoded",
    });
    if (!xml) throw new IguanaError("EmptyResponse", "search backend returned an empty body (session or Referer rejected)");
    return xml;
  }

  private async rest<T = any>(method: string, request: Record<string, unknown>): Promise<T> {
    await this.ensureSession();
    // restToken is already URL-safe as served (uses * escapes); pass it through untouched.
    const text = await this.http(`Rest.Server.cls?sessionId=${this.restToken}&method=${method}`, {
      method: "POST",
      body: JSON.stringify({ request }),
      contentType: "application/json",
    });
    if (!text) throw new IguanaError("EmptyResponse", `${method} returned an empty body`);
    const json = JSON.parse(text);
    const response = json.response ?? json;
    if (response?.error && response.result === undefined) {
      const err = response.error;
      const code = typeof err === "string" ? err : err.message ?? err.code ?? JSON.stringify(err);
      throw new IguanaError(String(code));
    }
    return response as T;
  }

  // ---- Catalogue (anonymous) ----------------------------------------------

  async search(opts: { query: string; index?: SearchIndex; limit?: number; start?: number; sort?: "relevance" | "newest" | "title" | "author" }): Promise<SearchResult> {
    const sortMap = { relevance: ["Relevancy", -1], newest: ["Year", -1], title: ["Title", 1], author: ["Author", 1] } as const;
    const [Sort, SortDirection] = sortMap[opts.sort ?? "relevance"];
    const index = SEARCH_INDEXES[opts.index ?? "keyword"];
    const xml = await this.searchRequest({
      RequestType: "ResultSet_DisplayList",
      NumberToRetrieve: opts.limit ?? 10,
      StartValue: opts.start ?? 1,
      SearchTechnique: "Find",
      ExportByTemplate: "Brief",
      TemplateId: "Iguana_Brief",
      FacetedSearch: "No",
      Cluster: 1,
      BestMatch: 99,
      Sort,
      SortDirection,
      WithoutRestrictions: "Yes",
      Associations: "Also",
      Index: index,
      Request: opts.query,
      SearchMode: "simple",
    });
    const result = parseSearchResponse(xml);
    await Promise.all(result.hits.filter((h) => h.kind === "cluster").map((h) => this.expandCluster(h, index, opts.query)));
    return result;
  }

  // Clusters list formats ("versions") and record ids separately with no link between
  // them. Fetch the cluster's records the way Search.ResultsCls.js does and attach each
  // record to its version. The server only resolves ClusterId within the original query,
  // so index + query must be the ones that produced the cluster.
  private async expandCluster(hit: SearchHit, index: string, query: string): Promise<void> {
    const fetchVersion = async (recordType: string) =>
      parseSearchResponse(
        await this.searchRequest({
          RequestType: "ResultSet_DisplayList",
          SearchTechnique: "Find",
          ExportByTemplate: "Brief",
          TemplateId: "Iguana_Brief",
          StartValue: 1,
          NumberToRetrieve: 200,
          ClusterId: hit.recordId,
          ClusterRecordType: recordType,
          Index: index,
          Request: query,
        }),
      ).hits.map(({ kind: _k, title: _t, authors: _a, ...rest }) => rest);

    const versions = hit.versions ?? [];
    const all = await fetchVersion("*");
    // Physical versions ("MT^AB") match a record's material type. E-formats ("M21^BE")
    // have none, so they share the leftovers; split those by asking per version.
    const unmatched = new Set(all.map((r) => r.recordId));
    const eVersions: ClusterVersion[] = [];
    for (const v of versions) {
      const mt = v.recordType.startsWith("MT^") ? v.recordType.slice(3) : undefined;
      if (mt) {
        v.records = all.filter((r) => r.materialType === mt);
        v.records.forEach((r) => unmatched.delete(r.recordId));
      } else eVersions.push(v);
    }
    if (eVersions.length === 1) {
      eVersions[0].records = all.filter((r) => unmatched.has(r.recordId));
    } else {
      await Promise.all(eVersions.map(async (v) => (v.records = await fetchVersion(v.recordType))));
    }
    delete hit.clusteredRecordIds;
  }

  async getRecord(recordId: string): Promise<RecordDetail> {
    const { db, num } = splitRecordId(recordId);
    const xml = await this.searchRequest({
      RequestType: "RecordNumber",
      Database: db,
      Request: num,
      TemplateId: "Iguana_Full",
      ExportByTemplate: "Full",
      Versions: 1,
    });
    return parseRecord(xml);
  }

  async getHoldings(recordId: string): Promise<HoldingItem[]> {
    const { db, num } = splitRecordId(recordId);
    // DetailedHoldings format copied from Search.Record.js: ^<locations>^^^%^<max>^^^<max>^flags...
    // Empty location list = all locations.
    const xml = await this.searchRequest({
      RequestType: "RecordNumber",
      Database: db,
      Request: num,
      DetailedHoldings: "^^^^%^200^^^200^true^false^true^true^true^true^^",
    });
    return parseHoldings(xml);
  }

  // ---- Patron account ------------------------------------------------------

  get hasCredentials(): boolean {
    return Boolean(this.cfg.cardNumber && this.cfg.pin);
  }

  private login(): Promise<void> {
    return this.once("login", () => this.doLogin());
  }

  private async doLogin(): Promise<void> {
    if (!this.hasCredentials) {
      throw new IguanaError("NoCredentials", "Set LIBRARY_CARD_NUMBER and LIBRARY_PIN to use account tools.");
    }
    const r = await this.rest<Record<string, unknown>>("user/credentials", {
      language: "eng",
      serviceProfile: this.cfg.profile,
      locationProfile: "",
      user: this.cfg.cardNumber,
      password: this.cfg.pin,
      institution: "",
    });
    if (typeof r.sessionId !== "string" || !r.sessionId) {
      throw new IguanaError("LoginFailed", "credentials accepted but no sessionId returned");
    }
    this.patronSessionId = r.sessionId;
    this.patron = r;
  }

  // Run an account call, logging in first and retrying once on a fresh session.
  private async account<T = any>(method: string, request: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      await this.ensureSession();
      if (!this.patronSessionId) await this.login();
      try {
        return await this.rest<T>(`user/${method}`, { sessionId: this.patronSessionId, ...request });
      } catch (e) {
        if (attempt > 0 || !(e instanceof IguanaError) || e.code === "NoCredentials") throw e;
        // Most likely an expired session: start over.
        this.sessionStartedAt = 0;
      }
    }
  }

  async patronInfo(): Promise<Record<string, unknown>> {
    await this.ensureSession();
    if (!this.patronSessionId) await this.login();
    const { sessionId: _s, ...rest } = this.patron ?? {};
    return rest;
  }

  summary() {
    return this.account("summary");
  }

  async loans(from = 1, to = 100) {
    return slimItems(await this.account("loans", { LocationProfile: "", range: { from, to }, sort: { sortBy: "!DueDate", sortDirection: "ASC" } }));
  }

  renew(barcodes: string[]) {
    return this.account("renewal", { items: barcodes.join(",") });
  }

  async holds(from = 1, to = 100) {
    return slimItems(await this.account("reservations", { LocationProfile: "", range: { from, to }, sort: { sortBy: "!QueuePosition", sortDirection: "ASC" } }));
  }

  cancelHolds(reservationNumbers: string[]) {
    return this.account("cancelreservation", { items: reservationNumbers.join(",") });
  }

  fines() {
    return this.account("paymentsdue", { sort: { sortBy: "", sortDirection: "" } });
  }

  loanHistory(from = 1, to = 50) {
    return this.account("loanhistory", { range: { from, to }, sort: { sortBy: "!LoanDate", sortDirection: "DESC" } });
  }

  // Holds are a server-driven wizard (Search.Reserve.js): step "record" returns the form
  // (fields + nextStep); step "reserve" submits it. LCL only asks for HdrPickupLocation.
  async placeHold(recordId: string, pickupLocation: string, reserveConfig: ReserveConfig) {
    const step = (name: string, extra: Record<string, unknown> = {}) =>
      this.account<ReserveResponse>("reserve", { step: name, serviceProfile: this.cfg.profile, ...extra });

    const form = await step("record", {
      recordId,
      clusterRecs: "",
      parameter: {
        type: reserveConfig.type,
        locationsRes: reserveConfig.reservationLocations,
        locationsPickup: reserveConfig.pickupLocations,
        fields: reserveConfig.fields,
        modExpDate: 0,
        confirmationMail: 0,
        confirmationSms: 0,
        locProfile: "",
      },
    });
    if (form.nextStep !== "reserve") {
      // Refused up front (e.g. already reserved, blocked card) or an unexpected flow.
      return { placed: false, stage: "record", response: form };
    }
    const fields = (form.fields ?? [])
      .filter((f) => f.canEdit != 0 || f.id === "HdrPickupLocation")
      .map((f) => ({ id: f.id, value: f.id === "HdrPickupLocation" ? pickupLocation : (f.value ?? "") }));
    const done = await step("reserve", { fields });
    return { placed: Number(done.result) === 1 && !done.error, stage: "reserve", response: done };
  }
}

export interface ReserveConfig {
  type: string;
  reservationLocations: string;
  pickupLocations: string;
  fields: string;
}

interface ReserveResponse {
  result?: number | string;
  nextStep?: string;
  fields?: { id: string; canEdit?: number | string; value?: string; type?: string; label?: string }[];
  error?: unknown;
  [k: string]: unknown;
}

// Drop the cover-image blob and collapse each hold's full pickup-branch list (every
// branch, one flagged selected) to just the chosen branch. Keeps tool output small.
function slimItems<T extends { items?: Record<string, any>[] }>(response: T): T {
  for (const item of response.items ?? []) {
    delete item.image;
    if (Array.isArray(item.pickupLocations)) {
      const sel = item.pickupLocations.find((p: { selected?: number }) => p.selected == 1);
      item.pickupLocation = sel ? { code: sel.code, name: sel.name } : undefined;
      delete item.pickupLocations;
    }
  }
  return response;
}

function splitRecordId(recordId: string): { db: string; num: string } {
  const m = recordId.trim().match(/^(\d+)\.(\d+)$/);
  if (!m) throw new IguanaError("BadRecordId", `record id must look like "1.750133", got "${recordId}"`);
  return { db: m[1], num: m[2] };
}
