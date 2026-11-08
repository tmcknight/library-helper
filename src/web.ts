// Web UI: a small JSON API over the same VegaClient the MCP tools use, plus the static
// single-page app in ../web. Only served in HTTP mode. The static files hold no data, so
// they're public; every /api request passes the same auth check as /mcp. Account routes use
// the card the browser signed in with (see sessions.ts), never the server's env card.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VegaError, SEARCH_TYPES, LIST_SORTS } from "./vega.ts";
import type { ListSort, SearchIndex, SearchSort, VegaClient } from "./vega.ts";
import { fetchBranchHours, libraryToday } from "./hours.ts";
import { BRANCHES, HOURS_URL, PICKUP_LOCATIONS } from "./lambton.ts";
import { maskCard, sessionCookie, sessionId, TooManyAttempts } from "./sessions.ts";
import type { Sessions } from "./sessions.ts";

export type LibraryClient = Pick<
  VegaClient,
  | "hasCredentials"
  | "search"
  | "getRecord"
  | "getAvailability"
  | "summary"
  | "loans"
  | "renew"
  | "holds"
  | "placeHold"
  | "cancelHolds"
  | "fines"
  | "loanHistory"
  | "lists"
  | "listItems"
  | "listsContaining"
  | "updateListItem"
>;

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const SORTS = ["relevance", "newest", "title", "author"] as const;
const MAX_BODY = 64 * 1024;

const recordIdOf = (s: string) => {
  if (!/^\d+$/.test(s)) throw new HttpError(400, `record id must be a number, got "${s}"`);
  return s;
};

function intParam(v: string | null, def: number, min: number, max: number): number {
  if (v == null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `expected an integer from ${min} to ${max}, got "${v}"`);
  return n;
}

// Vega's list and format group ids are UUIDs.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOf = (s: unknown, what: string) => {
  if (typeof s !== "string" || !UUID.test(s)) throw new HttpError(400, `${what} must be a UUID`);
  return s;
};

const branchOf = (code: string | undefined) => {
  if (code && !BRANCHES.some((b) => b.code === code)) throw new HttpError(400, `expected a branch code, got "${code}"`);
  return code;
};

function idList(body: unknown, key: string): string[] {
  const ids = (body as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === "string" && x)) {
    throw new HttpError(400, `${key} must be a non-empty array of strings`);
  }
  return ids;
}

// Routes an /api request. Returns the JSON body to send; throws HttpError or VegaError.
// `card` is the signed-in card number, if any.
export async function handleApi(client: LibraryClient, method: string, url: URL, body: unknown, card?: string): Promise<unknown> {
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const q = url.searchParams;
  const route = `${method} ${path}`;
  let m: RegExpMatchArray | null;

  if (route === "GET /config") {
    return {
      hasCredentials: client.hasCredentials,
      ...(card && { card: maskCard(card) }),
      branches: BRANCHES,
      pickupLocations: PICKUP_LOCATIONS,
    };
  }
  if (route === "GET /search") {
    const query = q.get("q")?.trim();
    if (!query) throw new HttpError(400, "q is required");
    const index = (q.get("index") || "keyword") as SearchIndex;
    if (!(index in SEARCH_TYPES)) throw new HttpError(400, `index must be one of ${Object.keys(SEARCH_TYPES).join(", ")}`);
    const sort = (q.get("sort") || "relevance") as SearchSort;
    if (!SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${SORTS.join(", ")}`);
    const branch = q.get("branch") || undefined;
    branchOf(branch);
    return client.search({ query, index, sort, page: intParam(q.get("page"), 1, 1, 1000), limit: intParam(q.get("limit"), 20, 1, 50), ...(branch && { branch }) });
  }
  if (method === "GET" && (m = path.match(/^\/records\/([^/]+)$/))) return client.getRecord(recordIdOf(m[1]));
  if (method === "GET" && (m = path.match(/^\/records\/([^/]+)\/availability$/))) return client.getAvailability(recordIdOf(m[1]));
  if (route === "GET /hours") return { today: libraryToday(), source: HOURS_URL, branches: await fetchBranchHours() };

  // Account
  if (route === "GET /account") return client.summary();
  if (route === "GET /loans") return client.loans(200);
  if (route === "POST /loans/renew") return client.renew(idList(body, "checkoutIds"));
  if (route === "GET /holds") return client.holds(200);
  if (route === "POST /holds") {
    const b = (body ?? {}) as Record<string, unknown>;
    const pickup = typeof b.pickupLocation === "string" ? b.pickupLocation : "";
    if (!/^\d+$/.test(pickup)) throw new HttpError(400, "pickupLocation must be a branch code");
    return client.placeHold(recordIdOf(String(b.recordId ?? "")), pickup);
  }
  if (route === "POST /holds/cancel") return client.cancelHolds(idList(body, "holdIds"));
  if (route === "GET /fines") return client.fines();
  if (route === "GET /history") return client.loanHistory(intParam(q.get("limit"), 100, 1, 200));

  // Reading lists
  if (route === "GET /lists") return client.lists();
  if (route === "GET /lists/containing") return client.listsContaining(uuidOf(q.get("id"), "id"));
  if (method === "GET" && (m = path.match(/^\/lists\/([^/]+)\/items$/))) {
    const sort = (q.get("sort") || "date.desc") as ListSort;
    if (!LIST_SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${LIST_SORTS.join(", ")}`);
    const availableAt = branchOf(q.get("availableAt") || undefined);
    return client.listItems(uuidOf(m[1], "list id"), {
      sort,
      page: intParam(q.get("page"), 1, 1, 1000),
      limit: intParam(q.get("limit"), 50, 1, 200),
      ...(availableAt && { availableAt }),
    });
  }
  if (route === "POST /lists/items") {
    // {formatGroupId, recordId?, title?, add: [listId], remove: [listId]}
    const b = (body ?? {}) as Record<string, unknown>;
    const lists = (key: string) => {
      const v = b[key] ?? [];
      if (!Array.isArray(v)) throw new HttpError(400, `${key} must be an array of list ids`);
      return v.map((x) => uuidOf(x, `${key} entries`));
    };
    const add = lists("add");
    const remove = lists("remove");
    if (!add.length && !remove.length) throw new HttpError(400, "nothing to add or remove");
    if (b.recordId != null && !/^\d+$/.test(String(b.recordId))) throw new HttpError(400, "recordId must be a number");
    if (b.title != null && typeof b.title !== "string") throw new HttpError(400, "title must be a string");
    return client.updateListItem(
      { formatGroupId: uuidOf(b.formatGroupId, "formatGroupId"), recordId: b.recordId == null ? undefined : String(b.recordId), title: (b.title as string | undefined)?.slice(0, 500) },
      add,
      remove,
    );
  }

  throw new HttpError(404, `no route ${route}`);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  // Requiring JSON makes a cross-site form post impossible: a browser has to preflight it,
  // and we never answer preflights, so cookie-based auth (Cloudflare Access) can't be ridden.
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) {
    throw new HttpError(415, "send Content-Type: application/json");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, "request body too large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "body is not valid JSON");
  }
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(value));
}

export interface WebApi {
  // For catalogue calls and anyone not signed in. Has no card.
  anonymous: LibraryClient;
  sessions: Sessions;
}

function credentials(body: unknown): { cardNumber: string; pin: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const cardNumber = typeof b.cardNumber === "string" ? b.cardNumber.replace(/\s+/g, "") : "";
  const pin = typeof b.pin === "string" ? b.pin : "";
  if (!/^[A-Za-z0-9]{4,32}$/.test(cardNumber)) throw new HttpError(400, "Enter your library card number.");
  if (!pin || pin.length > 64) throw new HttpError(400, "Enter your PIN.");
  return { cardNumber, pin };
}

export async function serveApi(web: WebApi, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (method !== "GET" && method !== "POST") throw new HttpError(405, `method ${method} not allowed`);
    const body = method === "POST" ? await readJson(req) : undefined;
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname.replace(/\/$/, "");
    const sid = sessionId(req);

    if (method === "POST" && path === "/api/login") {
      const { cardNumber, pin } = credentials(body);
      const id = await web.sessions.signIn(cardNumber, pin);
      // A browser that was signed in to another card drops that session.
      await web.sessions.signOut(sid);
      res.setHeader("Set-Cookie", sessionCookie(req, id, web.sessions.maxAgeSeconds));
      return sendJson(res, 200, { hasCredentials: true, card: maskCard(cardNumber) });
    }
    if (method === "POST" && path === "/api/logout") {
      await web.sessions.signOut(sid);
      res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
      return sendJson(res, 200, { hasCredentials: false });
    }

    const session = web.sessions.get(sid);
    // A stale cookie (expired, or from before a restart) is cleared so the page asks again.
    if (sid && !session) res.setHeader("Set-Cookie", sessionCookie(req, "", 0));
    sendJson(res, 200, await handleApi(session?.client ?? web.anonymous, method, url, body, session?.card));
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e instanceof TooManyAttempts) return sendJson(res, 429, { error: e.message });
    if (e instanceof VegaError) {
      const status = e.code === "NoCredentials" || e.code === "BadCredentials" ? 401 : e.code === "NotFound" ? 404 : e.code === "LoginFailed" ? 502 : 400;
      return sendJson(res, e.status && e.status >= 500 ? 502 : status, { error: e.message, code: e.code });
    }
    console.error(e);
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

// ---- Static files ------------------------------------------------------------

const WEB_DIR = new URL("../web/", import.meta.url);
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/icon.svg": { file: "icon.svg", type: "image/svg+xml" },
};

// Covers come from Syndetics (the library's own cover service) and, as a fallback, Open
// Library, which answers with a redirect to archive.org (then an iaNNNNNN.us.archive.org
// mirror), so those hosts have to be allowed too.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https://secure.syndetics.com https://covers.openlibrary.org https://archive.org https://*.us.archive.org data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

// Returns false when the path isn't a static file.
export async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
  const entry = STATIC[path === "/index.html" ? "/" : path];
  if (!entry) return false;
  const body = await readFile(new URL(entry.file, WEB_DIR));
  res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-cache", ...SECURITY_HEADERS });
  res.end(body);
  return true;
}
