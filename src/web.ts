// Web UI: a small JSON API over the same VegaClient the MCP tools use, plus the static
// single-page app in ../web. Only served in HTTP mode. The static files hold no data, so
// they're public; every /api request passes the same auth check as /mcp.

import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { VegaError, SEARCH_TYPES } from "./vega.ts";
import type { SearchIndex, SearchSort, VegaClient } from "./vega.ts";
import { fetchBranchHours, libraryToday } from "./hours.ts";
import { BRANCHES, HOURS_URL, PICKUP_LOCATIONS } from "./lambton.ts";

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

function idList(body: unknown, key: string): string[] {
  const ids = (body as Record<string, unknown> | undefined)?.[key];
  if (!Array.isArray(ids) || !ids.length || !ids.every((x) => typeof x === "string" && x)) {
    throw new HttpError(400, `${key} must be a non-empty array of strings`);
  }
  return ids;
}

// Routes an /api request. Returns the JSON body to send; throws HttpError or VegaError.
export async function handleApi(client: LibraryClient, method: string, url: URL, body: unknown): Promise<unknown> {
  const path = url.pathname.replace(/^\/api/, "").replace(/\/$/, "") || "/";
  const q = url.searchParams;
  const route = `${method} ${path}`;
  let m: RegExpMatchArray | null;

  if (route === "GET /config") {
    return { hasCredentials: client.hasCredentials, branches: BRANCHES, pickupLocations: PICKUP_LOCATIONS };
  }
  if (route === "GET /search") {
    const query = q.get("q")?.trim();
    if (!query) throw new HttpError(400, "q is required");
    const index = (q.get("index") || "keyword") as SearchIndex;
    if (!(index in SEARCH_TYPES)) throw new HttpError(400, `index must be one of ${Object.keys(SEARCH_TYPES).join(", ")}`);
    const sort = (q.get("sort") || "relevance") as SearchSort;
    if (!SORTS.includes(sort)) throw new HttpError(400, `sort must be one of ${SORTS.join(", ")}`);
    return client.search({ query, index, sort, page: intParam(q.get("page"), 1, 1, 1000), limit: intParam(q.get("limit"), 20, 1, 50) });
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

export async function serveApi(client: LibraryClient, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? "GET";
  try {
    if (method !== "GET" && method !== "POST") throw new HttpError(405, `method ${method} not allowed`);
    const body = method === "POST" ? await readJson(req) : undefined;
    sendJson(res, 200, await handleApi(client, method, new URL(req.url ?? "/", "http://x"), body));
  } catch (e) {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
    if (e instanceof VegaError) {
      const status = e.code === "NoCredentials" ? 401 : e.code === "NotFound" ? 404 : e.code === "LoginFailed" ? 502 : 400;
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

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' https://covers.openlibrary.org data:; style-src 'self' 'unsafe-inline'; script-src 'self'; " +
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
