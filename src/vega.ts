// Client for Innovative Vega Discover in front of Sierra (reverse-engineered from the
// portal's own Angular bundle).
//
// Everything is JSON under {apiUrl}/api/..., and every request names the library with
// iii-customer-domain / iii-host-domain plus an api-version header (1 unless noted).
// Catalogue calls work anonymously. Account calls need a Keycloak access token: the
// portal logs in with the authorization-code flow against a plain username/PIN form,
// which we drive directly. Access tokens last 10 minutes, refresh tokens 90 days.

import { SITE, branchName } from "./lambton.ts";
import * as map from "./vega-map.ts";
import type { RawFormatGroup, RawInstance, RawItem, RawCheckout, RawHold } from "./vega-map.ts";

export interface VegaConfig {
  cardNumber?: string;
  pin?: string;
}

export class VegaError extends Error {
  readonly code: string;
  readonly status?: number;
  constructor(code: string, message?: string, status?: number) {
    super(message ?? code);
    this.code = code;
    this.status = status;
  }
}

export const SEARCH_TYPES = {
  keyword: "everything",
  title: "title",
  author: "agent",
  subject: "concept",
  series: "series",
  call_number: "callNumber",
} as const;
export type SearchIndex = keyof typeof SEARCH_TYPES;

const SORTS = {
  relevance: ["relevance", "desc"],
  newest: ["publicationDate", "desc"],
  title: ["title", "asc"],
  author: ["author", "asc"],
} as const;
export type SearchSort = keyof typeof SORTS;

interface Tokens {
  access: string;
  accessExpires: number;
  refresh?: string;
  refreshExpires: number;
}

const EXPIRY_MARGIN_MS = 30_000;
const UA = "Mozilla/5.0 (library-helper MCP)";

type Json = Record<string, any>;

export class VegaClient {
  private readonly cfg: VegaConfig;
  private tokens: Tokens | null = null;
  private loggingIn: Promise<string> | null = null;
  private patronId = "";

  constructor(cfg: VegaConfig) {
    this.cfg = cfg;
  }

  // ---- HTTP plumbing -------------------------------------------------------

  private async api<T = any>(
    path: string,
    opts: { method?: string; body?: unknown; version?: string; auth?: boolean; query?: Record<string, string | number> } = {},
  ): Promise<T> {
    const url = new URL(`${SITE.apiUrl}/${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        "iii-customer-domain": SITE.portalDomain,
        "iii-host-domain": SITE.portalDomain,
        "api-version": opts.version ?? "1",
        Accept: "application/json",
        "User-Agent": UA,
      };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      if (opts.auth) headers.Authorization = `Bearer ${await this.accessToken()}`;
      const res = await fetch(url, {
        method: opts.method ?? "GET",
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      // A token can be revoked server-side before it expires; log in again once.
      if (res.status === 401 && opts.auth && attempt === 0) {
        this.tokens = null;
        continue;
      }
      const text = await res.text();
      const json = text ? safeJson(text) : undefined;
      if (!res.ok) throw apiError(res.status, json, text, path);
      return json as T;
    }
  }

  // ---- Auth ------------------------------------------------------------------

  get hasCredentials(): boolean {
    return Boolean(this.cfg.cardNumber && this.cfg.pin);
  }

  private async accessToken(): Promise<string> {
    const t = this.tokens;
    const now = Date.now();
    if (t && t.accessExpires - EXPIRY_MARGIN_MS > now) return t.access;
    // Share one login/refresh between concurrent calls.
    this.loggingIn ??= (async () => {
      try {
        if (t?.refresh && t.refreshExpires - EXPIRY_MARGIN_MS > now) {
          try {
            return await this.tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh });
          } catch {
            // Refresh token revoked or session ended; fall through to a fresh login.
          }
        }
        return await this.login();
      } finally {
        this.loggingIn = null;
      }
    })();
    return this.loggingIn;
  }

  private async login(): Promise<string> {
    if (!this.hasCredentials) {
      throw new VegaError("NoCredentials", "Set LIBRARY_CARD_NUMBER and LIBRARY_PIN to use account tools.");
    }
    const redirectUri = `https://${SITE.portalDomain}/`;
    const cookies = new Map<string, string>();
    const keep = (res: Response) => {
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(";");
        const eq = pair.indexOf("=");
        if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    };
    const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

    const authUrl = new URL(`${SITE.authUrl}/auth`);
    authUrl.search = new URLSearchParams({
      client_id: SITE.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid",
      state: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
    }).toString();
    const page = await fetch(authUrl, { redirect: "manual", headers: { "User-Agent": UA } });
    keep(page);
    const html = await page.text();
    const action = html.match(/id="kc-form-login"[^>]*\saction="([^"]+)"/)?.[1];
    if (!action) throw new VegaError("LoginFailed", `login form not found (HTTP ${page.status})`);

    const submit = await fetch(decodeEntities(action), {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookieHeader(), "User-Agent": UA },
      body: new URLSearchParams({ username: this.cfg.cardNumber!, password: this.cfg.pin! }).toString(),
    });
    const location = submit.headers.get("location");
    if (!location) {
      // Keycloak re-renders the form with a message on bad credentials.
      const body = await submit.text();
      const msg = body.match(/class="alert alert-error[^"]*">\s*<span[^>]*>([^<]+)/)?.[1] ?? body.match(/id="input-error"[^>]*>\s*([^<]+)/)?.[1];
      throw new VegaError("LoginFailed", msg ? decodeEntities(msg.trim()) : `login rejected (HTTP ${submit.status})`);
    }
    const loc = new URL(location);
    const code = loc.searchParams.get("code") ?? new URLSearchParams(loc.hash.slice(1)).get("code");
    if (!code) throw new VegaError("LoginFailed", `no authorization code in redirect: ${loc.searchParams.get("error") ?? location}`);
    return this.tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
  }

  private async tokenRequest(params: Record<string, string>): Promise<string> {
    const res = await fetch(`${SITE.authUrl}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({ client_id: SITE.clientId, ...params }).toString(),
    });
    const json = safeJson(await res.text()) as Json | undefined;
    if (!res.ok || !json?.access_token) {
      throw new VegaError("LoginFailed", json?.error_description ?? json?.error ?? `token endpoint HTTP ${res.status}`);
    }
    const now = Date.now();
    this.tokens = {
      access: json.access_token,
      accessExpires: now + (json.expires_in ?? 300) * 1000,
      refresh: json.refresh_token,
      refreshExpires: now + (json.refresh_expires_in ?? 0) * 1000,
    };
    return json.access_token;
  }

  // ---- Catalogue (anonymous) ----------------------------------------------

  async search(opts: { query: string; index?: SearchIndex; limit?: number; page?: number; sort?: SearchSort }) {
    const [sorting, sortOrder] = SORTS[opts.sort ?? "relevance"];
    const raw = await this.api<{ totalResults: number; totalPages: number; page: number; data: RawFormatGroup[] }>(
      "api/search-result/search/format-groups",
      {
        method: "POST",
        version: "2",
        body: {
          searchText: opts.query,
          searchType: SEARCH_TYPES[opts.index ?? "keyword"],
          sorting,
          sortOrder,
          pageNum: (opts.page ?? 1) - 1,
          pageSize: opts.limit ?? 10,
        },
      },
    );
    return map.searchResult(raw);
  }

  // A Sierra bib number names one edition; Vega keys full records by instance UUID.
  // The format group lookup by recordId gives both, plus that format's branch summary.
  private async resolve(recordId: string): Promise<{ group: RawFormatGroup; instanceId: string }> {
    if (!/^\d+$/.test(recordId)) throw new VegaError("BadRecordId", `record id must be a Sierra bib number like "57455", got "${recordId}"`);
    let group: RawFormatGroup;
    try {
      group = await this.api<RawFormatGroup>("api/search-result/search/format-groups", { query: { recordId } });
    } catch (e) {
      if (e instanceof VegaError && e.status === 404) throw new VegaError("NotFound", `no catalogue record ${recordId}`);
      throw e;
    }
    const edition = map.findEdition(group, recordId);
    if (!edition?.id) throw new VegaError("NotFound", `record ${recordId} has no edition in format group ${group.id}`);
    return { group, instanceId: edition.id };
  }

  async getRecord(recordId: string) {
    const { group, instanceId } = await this.resolve(recordId);
    const instance = await this.api<RawInstance>(`api/search-result/search/instances/${instanceId}`);
    return map.record(group, instance, recordId);
  }

  async getAvailability(recordId: string) {
    const { instanceId } = await this.resolve(recordId);
    const items = await this.api<RawItem[]>(`api/search-result/search/instances/${instanceId}/items`);
    return map.items(items);
  }

  // ---- Patron account ------------------------------------------------------

  private async me(): Promise<Json> {
    const me = await this.api<Json>("api/search-result/patrons/me", { auth: true, version: "2", query: { listsPrefetch: 1 } });
    this.patronId = String(me.id);
    return me;
  }

  private checkouts() {
    return this.api<RawCheckout[]>("api/search-result/patrons/me/checkouts", { auth: true });
  }

  private rawHolds() {
    return this.api<RawHold[]>("api/search-result/patrons/me/holds", { auth: true });
  }

  async summary() {
    const [me, checkouts, holds] = await Promise.all([this.me(), this.checkouts(), this.rawHolds()]);
    const now = Date.now();
    const loans = checkouts.map((c) => map.loan(c, now));
    const holdList = holds.map(map.hold);
    return {
      cardExpires: me.expirationDate,
      homeLibrary: branchName(me.homeLibraryCode),
      preferredPickupLocation: branchName(me.preferredPickupLocationCode),
      moneyOwed: me.moneyOwed,
      loans: loans.length,
      overdue: loans.filter((l) => l.overdue).length,
      dueWithin3Days: loans.filter((l) => !l.overdue && Date.parse(l.dueDate) - now < 3 * 86_400_000).length,
      holds: holdList.length,
      holdsReadyForPickup: holdList.filter((h) => h.readyForPickup).length,
    };
  }

  async loans(limit = 100) {
    const now = Date.now();
    return (await this.checkouts())
      .map((c) => map.loan(c, now))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
      .slice(0, limit);
  }

  async renew(checkoutIds: string[]) {
    const results = [];
    // One at a time: the portal does the same, and Sierra serialises them anyway.
    for (const id of checkoutIds) {
      try {
        const r = await this.api<RawCheckout | undefined>(`api/search-result/patrons/me/checkouts/${encodeURIComponent(id)}/renew`, {
          method: "POST",
          auth: true,
        });
        results.push({ checkoutId: id, renewed: true, ...(r?.dueDate && { dueDate: r.dueDate, renewalCount: r.renewalCount }) });
      } catch (e) {
        results.push({ checkoutId: id, renewed: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  async holds(limit = 100) {
    return (await this.rawHolds()).map(map.hold).slice(0, limit);
  }

  // Same two steps as the portal: the request form says where this record can be picked
  // up (and whether a volume must be chosen), then POST gates/holds places it.
  async placeHold(recordId: string, pickupLocation: string) {
    if (!/^\d+$/.test(recordId)) throw new VegaError("BadRecordId", `record id must be a Sierra bib number like "57455", got "${recordId}"`);
    if (!this.patronId) await this.me();
    const form = await this.api<{ pickupLocations?: { code: string; name: string }[]; volumes?: unknown[]; itemsAsVolumes?: unknown[] }>(
      "api/search-result/gates/request-form",
      { method: "POST", auth: true, body: { patronId: this.patronId, recordNumber: [{ recordId }], recordType: "b" } },
    );
    if (form.volumes?.length || form.itemsAsVolumes?.length) {
      throw new VegaError("VolumeRequired", "this record has volumes; place the hold on the library website and pick a volume there");
    }
    const pickups = form.pickupLocations ?? [];
    if (pickups.length && !pickups.some((p) => p.code === pickupLocation)) {
      throw new VegaError(
        "BadPickupLocation",
        `"${pickupLocation}" isn't a pickup location for this record. Valid: ${pickups.map((p) => `${p.code} (${p.name})`).join(", ")}`,
      );
    }
    const response = await this.api("api/search-result/gates/holds", {
      method: "POST",
      auth: true,
      body: { patronId: this.patronId, recordNumber: recordId, recordType: "b", pickupLocation },
    });
    return { placed: true, recordId, pickupLocation: { code: pickupLocation, name: branchName(pickupLocation) }, response };
  }

  async cancelHolds(holdIds: string[]) {
    const results = [];
    for (const id of holdIds) {
      try {
        await this.api(`api/search-result/gates/holds/${encodeURIComponent(id)}`, { method: "DELETE", auth: true });
        results.push({ holdId: id, cancelled: true });
      } catch (e) {
        results.push({ holdId: id, cancelled: false, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return results;
  }

  async fines() {
    return map.fines(await this.api<{ totalOutstandingAmount?: number; data?: map.RawFine[] }>("api/search-result/gates/patrons/me/fines", { auth: true }));
  }

  async loanHistory(limit = 50) {
    const status = await this.api<{ readingHistoryActivation?: boolean }>(
      "api/search-result/patrons/me/checkouts/history/activation-status",
      { auth: true },
    );
    if (!status.readingHistoryActivation) {
      return { enabled: false, message: "Reading history is turned off for this card. It can be turned on in the library website's account settings; it only records loans from then on." };
    }
    // Same sort the portal uses for its reading-history page.
    const raw = await this.api<{ items: { totalResults: number; data: map.RawHistoryItem[] } }>("api/search-result/bookshelf/reading-history", {
      auth: true,
      query: { sortBy: "checkoutDate.desc", pageNum: 0, pageSize: limit },
    });
    return { enabled: true, total: raw.items.totalResults, items: raw.items.data.map(map.historyItem) };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Vega errors look like {status, type, message, cause, error: [{message, target}]}.
function apiError(status: number, json: any, text: string, path: string): VegaError {
  const detail = Array.isArray(json?.error) && json.error.length ? json.error.map((e: any) => e.message).join("; ") : "";
  const message = [json?.message, detail].filter(Boolean).join(": ") || text.slice(0, 200) || `HTTP ${status}`;
  const code = status === 401 ? "Unauthorized" : status === 404 ? "NotFound" : (json?.type ?? json?.cause ?? `Http${status}`);
  return new VegaError(String(code), `${message} (${path})`, status);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
