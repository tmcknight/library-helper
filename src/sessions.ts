// Web UI sign-in: each browser signs in with its own library card and gets its own library
// session, keyed by a random id in an HttpOnly cookie. Sessions live in memory only, so a
// restart signs everyone out. The env card (LIBRARY_CARD_NUMBER) is for MCP and isn't used here.

import { randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { LibraryClient } from "./web.ts";

export interface SessionClient extends LibraryClient {
  signIn(): Promise<void>;
  signOut(): Promise<void>;
}

interface Session {
  client: SessionClient;
  card: string;
  lastUsed: number;
}

export const COOKIE = "lh_session";
const DAY = 86_400_000;

export interface SessionOptions {
  // Signed out after this long unused. Vega's refresh token lasts 90 days.
  idleMs?: number;
  // Oldest-used sessions are dropped beyond this.
  max?: number;
  // Failed sign-ins allowed per minute across the server, before answering 429.
  failuresPerMinute?: number;
  now?: () => number;
}

export class Sessions {
  private readonly byId = new Map<string, Session>();
  private readonly make: (cardNumber: string, pin: string) => SessionClient;
  private readonly idleMs: number;
  private readonly max: number;
  private readonly failuresPerMinute: number;
  private readonly now: () => number;
  private failures: number[] = [];

  constructor(make: (cardNumber: string, pin: string) => SessionClient, opts: SessionOptions = {}) {
    this.make = make;
    this.idleMs = opts.idleMs ?? 30 * DAY;
    this.max = opts.max ?? 100;
    this.failuresPerMinute = opts.failuresPerMinute ?? 10;
    this.now = opts.now ?? Date.now;
  }

  get maxAgeSeconds(): number {
    return Math.floor(this.idleMs / 1000);
  }

  get(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    const s = this.byId.get(id);
    if (!s) return undefined;
    const now = this.now();
    if (now - s.lastUsed > this.idleMs) {
      this.drop(id);
      return undefined;
    }
    s.lastUsed = now;
    return s;
  }

  // Logs in to the library; throws the client's error (BadCredentials etc.) on failure.
  async signIn(cardNumber: string, pin: string): Promise<string> {
    const now = this.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    if (this.failures.length >= this.failuresPerMinute) throw new TooManyAttempts();
    const client = this.make(cardNumber, pin);
    try {
      await client.signIn();
    } catch (e) {
      this.failures.push(now);
      throw e;
    }
    const id = randomBytes(32).toString("base64url");
    this.byId.set(id, { client, card: cardNumber, lastUsed: now });
    this.prune();
    return id;
  }

  async signOut(id: string | undefined): Promise<void> {
    if (id && this.byId.has(id)) await this.drop(id);
  }

  private drop(id: string): Promise<void> {
    const s = this.byId.get(id);
    this.byId.delete(id);
    return s ? s.client.signOut().catch(() => {}) : Promise.resolve();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, s] of this.byId) if (now - s.lastUsed > this.idleMs) void this.drop(id);
    if (this.byId.size <= this.max) return;
    const oldest = [...this.byId].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id] of oldest.slice(0, this.byId.size - this.max)) void this.drop(id);
  }
}

export class TooManyAttempts extends Error {
  constructor() {
    super("Too many failed sign-ins. Wait a minute and try again.");
  }
}

export function sessionId(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === COOKIE) return part.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

// Secure when the browser reached us over HTTPS, directly or through a proxy/tunnel.
export function sessionCookie(req: IncomingMessage, value: string, maxAgeSeconds: number): string {
  const https = (req.socket as { encrypted?: boolean }).encrypted || /^https\b/i.test(String(req.headers["x-forwarded-proto"] ?? ""));
  return [`${COOKIE}=${value}`, "Path=/api", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`, ...(https ? ["Secure"] : [])].join("; ");
}

// "•••• 1234": enough to tell cards apart without echoing the number.
export const maskCard = (card: string) => `•••• ${card.slice(-4)}`;
