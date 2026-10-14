import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

// Throws to reject the request; the message is logged, never sent to the client.
export type Verifier = (req: IncomingMessage) => Promise<void>;

export const AUTH_MODES = ["cloudflare-access", "jwt", "bearer", "none"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

type Env = Record<string, string | undefined>;

export interface AuthOptions {
  // Swaps the remote JWKS fetch for a fixed key set (tests).
  keys?: (jwksUrl: URL) => JWTVerifyGetKey;
}

// Picks the HTTP auth check from the environment. AUTH_MODE wins; without it the mode is
// inferred from which settings are present, so existing CF_ACCESS_* deployments keep working.
export function authFromEnv(env: Env, opts: AuthOptions = {}): { mode: AuthMode; verify: Verifier } {
  const mode = resolveMode(env);
  const keys = opts.keys ?? ((url: URL) => createRemoteJWKSet(url));
  const allowed = env.ALLOWED_EMAILS?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

  switch (mode) {
    case "cloudflare-access": {
      // Cloudflare Access puts a signed JWT in Cf-Access-Jwt-Assertion on every request it lets
      // through. Checking it means the origin can't be reached by going around the tunnel.
      const team = required(env, "CF_ACCESS_TEAM_DOMAIN"); // e.g. https://yourteam.cloudflareaccess.com
      const aud = required(env, "CF_ACCESS_AUD"); // the Access application's Audience (AUD) tag
      const issuer = team.replace(/\/$/, "");
      return {
        mode,
        verify: jwtVerifier({
          header: "cf-access-jwt-assertion",
          keys: keys(new URL(`${issuer}/cdn-cgi/access/certs`)),
          issuer,
          audience: aud,
          allowed,
        }),
      };
    }
    case "jwt":
      // Any identity-aware proxy that forwards a signed JWT: Pomerium, oauth2-proxy, Authentik, IAP, ...
      return {
        mode,
        verify: jwtVerifier({
          header: (env.AUTH_JWT_HEADER ?? "authorization").toLowerCase(),
          keys: keys(new URL(required(env, "AUTH_JWKS_URL"))),
          issuer: env.AUTH_ISSUER || undefined,
          audience: required(env, "AUTH_AUDIENCE"),
          allowed,
        }),
      };
    case "bearer": {
      // A shared secret, for clients that can send headers (Claude Code, the Inspector).
      // claude.ai connectors can't: they need OAuth, i.e. one of the JWT modes behind a proxy.
      const expected = digest(required(env, "AUTH_TOKEN"));
      return {
        mode,
        verify: async (req) => {
          const token = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
          if (!token) throw new Error("missing bearer token");
          if (!timingSafeEqual(digest(token), expected)) throw new Error("wrong bearer token");
        },
      };
    }
    case "none":
      console.error("WARNING: HTTP auth disabled; anyone who can reach this port can use the card");
      return { mode, verify: async () => {} };
  }
}

function resolveMode(env: Env): AuthMode {
  if (env.AUTH_MODE) {
    if (!(AUTH_MODES as readonly string[]).includes(env.AUTH_MODE)) {
      throw new Error(`AUTH_MODE must be one of ${AUTH_MODES.join(", ")}; got "${env.AUTH_MODE}"`);
    }
    return env.AUTH_MODE as AuthMode;
  }
  if (env.CF_ACCESS_TEAM_DOMAIN || env.CF_ACCESS_AUD) return "cloudflare-access";
  if (env.AUTH_JWKS_URL) return "jwt";
  if (env.AUTH_TOKEN) return "bearer";
  if (env.ALLOW_UNAUTHENTICATED === "1") return "none";
  throw new Error("No HTTP auth configured. Set AUTH_MODE (cloudflare-access, jwt, bearer or none) and its settings; see README.");
}

function jwtVerifier(o: {
  header: string;
  keys: JWTVerifyGetKey;
  issuer?: string;
  audience: string;
  allowed?: string[];
}): Verifier {
  return async (req) => {
    let token = req.headers[o.header];
    if (typeof token !== "string") throw new Error(`missing ${o.header} header`);
    if (o.header === "authorization") token = token.replace(/^Bearer /i, "");
    const { payload } = await jwtVerify(token, o.keys, { issuer: o.issuer, audience: o.audience });
    if (o.allowed?.length && !o.allowed.includes(String(payload.email ?? "").toLowerCase())) {
      throw new Error(`email ${payload.email} not in ALLOWED_EMAILS`);
    }
  };
}

function required(env: Env, name: string): string {
  const v = env[name];
  if (!v) throw new Error(`Set ${name} for AUTH_MODE=${resolveMode(env)}`);
  return v;
}

// Hashing first keeps timingSafeEqual's inputs the same length.
function digest(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}
