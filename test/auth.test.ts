import { test } from "node:test";
import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { authFromEnv } from "../src/auth.ts";

const { privateKey, publicKey } = await generateKeyPair("ES256");
const jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), alg: "ES256" }] });
const keyUrls: string[] = [];
const keys = (url: URL) => (keyUrls.push(url.href), jwks);

const req = (headers: Record<string, string>) => ({ headers }) as IncomingMessage;

function sign(claims: { iss?: string; aud?: string; email?: string }, key = privateKey) {
  const jwt = new SignJWT({ email: claims.email }).setProtectedHeader({ alg: "ES256" }).setExpirationTime("5m");
  if (claims.iss) jwt.setIssuer(claims.iss);
  if (claims.aud) jwt.setAudience(claims.aud);
  return jwt.sign(key);
}

test("auth: mode inferred from settings, CF_ACCESS_* first", () => {
  const mode = (env: Record<string, string>) => authFromEnv(env, { keys }).mode;
  assert.equal(mode({ CF_ACCESS_TEAM_DOMAIN: "https://t.cloudflareaccess.com", CF_ACCESS_AUD: "a", AUTH_TOKEN: "x" }), "cloudflare-access");
  assert.equal(mode({ AUTH_JWKS_URL: "https://idp/jwks", AUTH_AUDIENCE: "a" }), "jwt");
  assert.equal(mode({ AUTH_TOKEN: "x" }), "bearer");
  assert.equal(mode({ ALLOW_UNAUTHENTICATED: "1" }), "none");
  assert.equal(mode({ AUTH_MODE: "none", CF_ACCESS_AUD: "a" }), "none");
});

test("auth: refuses to start without auth or with incomplete settings", () => {
  assert.throws(() => authFromEnv({}), /No HTTP auth configured/);
  assert.throws(() => authFromEnv({ AUTH_MODE: "basic" }), /AUTH_MODE must be one of/);
  assert.throws(() => authFromEnv({ CF_ACCESS_AUD: "a" }), /Set CF_ACCESS_TEAM_DOMAIN/);
  assert.throws(() => authFromEnv({ AUTH_JWKS_URL: "https://idp/jwks" }), /Set AUTH_AUDIENCE/);
  assert.throws(() => authFromEnv({ AUTH_MODE: "bearer" }), /Set AUTH_TOKEN/);
});

test("auth: cloudflare-access checks Cf-Access-Jwt-Assertion against the team", async () => {
  const iss = "https://t.cloudflareaccess.com";
  const { verify } = authFromEnv(
    { CF_ACCESS_TEAM_DOMAIN: `${iss}/`, CF_ACCESS_AUD: "aud1", ALLOWED_EMAILS: "Me@x.com, you@x.com" },
    { keys },
  );
  assert.equal(keyUrls.at(-1), `${iss}/cdn-cgi/access/certs`);

  await verify(req({ "cf-access-jwt-assertion": await sign({ iss, aud: "aud1", email: "me@x.com" }) }));
  await assert.rejects(verify(req({})), /missing cf-access-jwt-assertion/);
  await assert.rejects(verify(req({ "cf-access-jwt-assertion": await sign({ iss, aud: "other", email: "me@x.com" }) })), /aud/);
  await assert.rejects(verify(req({ "cf-access-jwt-assertion": await sign({ iss: "https://evil", aud: "aud1", email: "me@x.com" }) })), /iss/);
  await assert.rejects(verify(req({ "cf-access-jwt-assertion": await sign({ iss, aud: "aud1", email: "them@x.com" }) })), /not in ALLOWED_EMAILS/);

  const other = await generateKeyPair("ES256");
  await assert.rejects(verify(req({ "cf-access-jwt-assertion": await sign({ iss, aud: "aud1", email: "me@x.com" }, other.privateKey) })));
});

test("auth: jwt reads Authorization by default, or a custom header", async () => {
  const env = { AUTH_JWKS_URL: "https://idp/jwks", AUTH_AUDIENCE: "aud1", AUTH_ISSUER: "https://idp" };
  const token = await sign({ iss: "https://idp", aud: "aud1" });

  await authFromEnv(env, { keys }).verify(req({ authorization: `Bearer ${token}` }));
  await assert.rejects(authFromEnv(env, { keys }).verify(req({ authorization: `Bearer ${await sign({ iss: "https://other", aud: "aud1" })}` })), /iss/);

  const custom = authFromEnv({ ...env, AUTH_JWT_HEADER: "X-Pomerium-Jwt-Assertion" }, { keys });
  await custom.verify(req({ "x-pomerium-jwt-assertion": token }));
  await assert.rejects(custom.verify(req({ authorization: `Bearer ${token}` })), /missing x-pomerium-jwt-assertion/);
});

test("auth: bearer compares the shared token", async () => {
  const { verify } = authFromEnv({ AUTH_TOKEN: "s3cret" });
  await verify(req({ authorization: "Bearer s3cret" }));
  await assert.rejects(verify(req({ authorization: "Bearer s3cre" })), /wrong bearer token/);
  await assert.rejects(verify(req({ authorization: "s3cret" })), /missing bearer token/);
  await assert.rejects(verify(req({})), /missing bearer token/);
});
