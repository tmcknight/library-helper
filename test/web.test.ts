import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi, HttpError, serveApi, serveStatic } from "../src/web.ts";
import type { LibraryClient } from "../src/web.ts";
import { VegaError } from "../src/vega.ts";
import { Sessions } from "../src/sessions.ts";
import type { SessionClient } from "../src/sessions.ts";

// Records each call so tests can check what the API passed through.
function fakeClient(over: Partial<LibraryClient> = {}) {
  const calls: [string, unknown[]][] = [];
  const rec =
    (name: string, result: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, args]);
      return result;
    };
  const client = {
    hasCredentials: true,
    search: rec("search", { total: 0, page: 1, totalPages: 0, hits: [] }),
    getRecord: rec("getRecord", { recordId: "1" }),
    getAvailability: rec("getAvailability", []),
    summary: rec("summary", { loans: 0 }),
    loans: rec("loans", []),
    renew: rec("renew", [{ renewed: true }]),
    holds: rec("holds", []),
    placeHold: rec("placeHold", { placed: true }),
    cancelHolds: rec("cancelHolds", [{ cancelled: true }]),
    fines: rec("fines", { totalOutstanding: 0, fines: [] }),
    loanHistory: rec("loanHistory", { enabled: false }),
    lists: rec("lists", []),
    listItems: rec("listItems", { total: 0, page: 1, totalPages: 0, items: [] }),
    listsContaining: rec("listsContaining", { lists: [], containing: [] }),
    updateListItem: rec("updateListItem", { addedTo: [], removedFrom: [] }),
    ...over,
  } as unknown as LibraryClient;
  return { client, calls };
}

const u = (path: string) => new URL(path, "http://x");

test("search: passes validated params through with defaults", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "GET", u("/api/search?q=hail+mary&index=title&sort=newest&page=2"), undefined);
  assert.deepEqual(calls, [["search", [{ query: "hail mary", index: "title", sort: "newest", page: 2, limit: 20 }]]]);
  calls.length = 0;
  await handleApi(client, "GET", u("/api/search?q=penny&branch=19"), undefined);
  assert.deepEqual(calls, [["search", [{ query: "penny", index: "keyword", sort: "relevance", page: 1, limit: 20, branch: "19" }]]]);
});

test("search: rejects missing query and unknown index/sort/page", async () => {
  const { client } = fakeClient();
  for (const path of ["/api/search", "/api/search?q=x&index=isbn", "/api/search?q=x&sort=random", "/api/search?q=x&page=0", "/api/search?q=x&limit=500", "/api/search?q=x&branch=999"]) {
    await assert.rejects(handleApi(client, "GET", u(path), undefined), (e) => e instanceof HttpError && e.status === 400, path);
  }
});

test("records: numeric ids only", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "GET", u("/api/records/57455"), undefined);
  await handleApi(client, "GET", u("/api/records/57455/availability"), undefined);
  assert.deepEqual(calls, [["getRecord", ["57455"]], ["getAvailability", ["57455"]]]);
  await assert.rejects(handleApi(client, "GET", u("/api/records/abc"), undefined), HttpError);
});

test("account writes validate their bodies", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "POST", u("/api/loans/renew"), { checkoutIds: ["c1", "c2"] });
  await handleApi(client, "POST", u("/api/holds"), { recordId: "57455", pickupLocation: "19" });
  await handleApi(client, "POST", u("/api/holds/cancel"), { holdIds: ["h1"] });
  assert.deepEqual(calls, [
    ["renew", [["c1", "c2"]]],
    ["placeHold", ["57455", "19"]],
    ["cancelHolds", [["h1"]]],
  ]);
  await assert.rejects(handleApi(client, "POST", u("/api/loans/renew"), { checkoutIds: [] }), HttpError);
  await assert.rejects(handleApi(client, "POST", u("/api/holds"), { recordId: "57455", pickupLocation: "Petrolia" }), HttpError);
  await assert.rejects(handleApi(client, "POST", u("/api/holds/cancel"), { holdIds: [1] }), HttpError);
});

test("unknown routes and wrong methods are 404", async () => {
  const { client } = fakeClient();
  await assert.rejects(handleApi(client, "GET", u("/api/nope"), undefined), (e) => e instanceof HttpError && e.status === 404);
  await assert.rejects(handleApi(client, "GET", u("/api/holds/cancel"), undefined), (e) => e instanceof HttpError && e.status === 404);
});

// Signed-in browsers get `client` (as a session client); the anonymous client has no card.
function fakeSessions(client: LibraryClient, log: string[] = [], goodPin = "1234") {
  return new Sessions((card, pin) => ({
    ...client,
    signIn: async () => {
      if (pin !== goodPin) throw new VegaError("BadCredentials", "Invalid username or password.");
      log.push(`in ${card}`);
    },
    signOut: async () => void log.push(`out ${card}`),
  }) as SessionClient);
}

async function withServer(client: LibraryClient, fn: (base: string) => Promise<void>, sessions = fakeSessions(client)) {
  const anonymous = { ...client, hasCredentials: false } as LibraryClient;
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && (await serveStatic(path, res))) return;
    await serveApi({ anonymous, sessions }, req, res);
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

test("http: POST needs a JSON content type (no cross-site form posts)", async () => {
  const { client, calls } = fakeClient();
  await withServer(client, async (base) => {
    const form = await fetch(`${base}/api/holds/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "holdIds=h1",
    });
    assert.equal(form.status, 415);
    assert.equal(calls.length, 0);
    const ok = await fetch(`${base}/api/holds/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdIds: ["h1"] }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), [{ cancelled: true }]);
  });
});

test("http: library errors map to status codes with a JSON message", async () => {
  const { client } = fakeClient({
    summary: async () => {
      throw new VegaError("NoCredentials", "Set LIBRARY_CARD_NUMBER");
    },
  });
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/api/account`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: "Set LIBRARY_CARD_NUMBER", code: "NoCredentials" });
  });
});

test("http: serves the app shell with a CSP", async () => {
  const { client } = fakeClient();
  await withServer(client, async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type")!, /text\/html/);
    const csp = res.headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self'/);
    // Open Library covers redirect to archive.org mirrors.
    assert.match(csp, /img-src [^;]*https:\/\/covers\.openlibrary\.org https:\/\/archive\.org https:\/\/\*\.us\.archive\.org/);
    assert.match(await res.text(), /<script type="module" src="app.js">/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  });
});

const L1 = "5196b1b2-5b7c-4570-b8b6-bc45a0bb6f9f";
const FG = "a6715cb2-4f17-511a-a2d9-e73c9f2c0807";

test("lists: reads pass validated ids and sort through", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "GET", u("/api/lists"), undefined);
  await handleApi(client, "GET", u(`/api/lists/${L1}/items?sort=title.asc&page=2`), undefined);
  await handleApi(client, "GET", u(`/api/lists/containing?id=${FG}`), undefined);
  await handleApi(client, "GET", u(`/api/lists/${L1}/items?availableAt=19`), undefined);
  assert.deepEqual(calls, [
    ["lists", []],
    ["listItems", [L1, { sort: "title.asc", page: 2, limit: 50 }]],
    ["listsContaining", [FG]],
    ["listItems", [L1, { sort: "date.desc", page: 1, limit: 50, availableAt: "19" }]],
  ]);
  for (const path of ["/api/lists/not-a-uuid/items", `/api/lists/${L1}/items?sort=random`, `/api/lists/${L1}/items?availableAt=99`, "/api/lists/containing", "/api/lists/containing?id=1"]) {
    await assert.rejects(handleApi(client, "GET", u(path), undefined), (e) => e instanceof HttpError && e.status === 400, path);
  }
});

test("lists: add/remove validates the body", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "POST", u("/api/lists/items"), { formatGroupId: FG, recordId: "33990", title: "Seven fallen feathers", add: [L1] });
  assert.deepEqual(calls, [["updateListItem", [{ formatGroupId: FG, recordId: "33990", title: "Seven fallen feathers" }, [L1], []]]]);
  const bad = [
    { formatGroupId: FG },
    { formatGroupId: FG, add: [] },
    { formatGroupId: "x", add: [L1] },
    { formatGroupId: FG, add: ["x"] },
    { formatGroupId: FG, add: L1 },
    { formatGroupId: FG, remove: [L1], recordId: "b123" },
    { formatGroupId: FG, remove: [L1], title: 5 },
  ];
  for (const body of bad) {
    await assert.rejects(handleApi(client, "POST", u("/api/lists/items"), body), (e) => e instanceof HttpError && e.status === 400, JSON.stringify(body));
  }
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("http: sign in sets an HttpOnly session cookie; sign out ends it", async () => {
  const { client } = fakeClient();
  const log: string[] = [];
  await withServer(client, async (base) => {
    assert.equal((await (await fetch(`${base}/api/config`)).json()).hasCredentials, false);

    const bad = await post(base, "/api/login", { cardNumber: "29999000123456", pin: "0000" });
    assert.equal(bad.status, 401);
    assert.deepEqual(await bad.json(), { error: "Invalid username or password.", code: "BadCredentials" });
    assert.equal(bad.headers.get("set-cookie"), null);

    const ok = await post(base, "/api/login", { cardNumber: "2999 9000 123456", pin: "1234" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { hasCredentials: true, card: "•••• 3456" });
    const set = ok.headers.get("set-cookie")!;
    assert.match(set, /^lh_session=[\w-]{43}; Path=\/api; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
    const cookie = set.split(";")[0];

    const cfg = await (await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).json();
    assert.equal(cfg.hasCredentials, true);
    assert.equal(cfg.card, "•••• 3456");

    const out = await post(base, "/api/logout", {}, { Cookie: cookie });
    assert.match(out.headers.get("set-cookie")!, /^lh_session=; .*Max-Age=0/);
    // The old cookie no longer signs anyone in, and is cleared.
    const after = await fetch(`${base}/api/config`, { headers: { Cookie: cookie } });
    assert.equal((await after.json()).hasCredentials, false);
    assert.match(after.headers.get("set-cookie")!, /Max-Age=0/);
  }, fakeSessions(client, log));
  assert.deepEqual(log, ["in 29999000123456", "out 29999000123456"]);
});

test("http: cookie is Secure behind an HTTPS proxy; signing in again drops the old session", async () => {
  const { client } = fakeClient();
  const log: string[] = [];
  await withServer(client, async (base) => {
    const first = await post(base, "/api/login", { cardNumber: "11112222", pin: "1234" }, { "X-Forwarded-Proto": "https" });
    assert.match(first.headers.get("set-cookie")!, /; Secure$/);
    const cookie = first.headers.get("set-cookie")!.split(";")[0];
    await post(base, "/api/login", { cardNumber: "33334444", pin: "1234" }, { Cookie: cookie });
    assert.equal((await (await fetch(`${base}/api/config`, { headers: { Cookie: cookie } })).json()).hasCredentials, false);
  }, fakeSessions(client, log));
  assert.deepEqual(log, ["in 11112222", "in 33334444", "out 11112222"]);
});

test("http: sign-in validates input and throttles failures", async () => {
  const { client } = fakeClient();
  const sessions = new Sessions(() => ({ ...client, signIn: async () => { throw new VegaError("BadCredentials", "no"); }, signOut: async () => {} }) as SessionClient, { failuresPerMinute: 2 });
  await withServer(client, async (base) => {
    for (const body of [{}, { cardNumber: "12", pin: "1" }, { cardNumber: "12345678" }, { cardNumber: "1234<script>", pin: "1" }]) {
      assert.equal((await post(base, "/api/login", body)).status, 400, JSON.stringify(body));
    }
    assert.equal((await post(base, "/api/login", { cardNumber: "12345678", pin: "1" })).status, 401);
    assert.equal((await post(base, "/api/login", { cardNumber: "12345678", pin: "1" })).status, 401);
    assert.equal((await post(base, "/api/login", { cardNumber: "12345678", pin: "1" })).status, 429);
  }, sessions);
});

test("sessions: expire when idle and cap how many are kept", async () => {
  let now = 0;
  const out: string[] = [];
  const make = (card: string) => ({ signIn: async () => {}, signOut: async () => void out.push(card) }) as unknown as SessionClient;
  const s = new Sessions(make, { idleMs: 1000, max: 2, now: () => now });
  const a = await s.signIn("a", "p");
  now = 500;
  assert.ok(s.get(a));
  now = 1400; // 900ms after last use
  assert.ok(s.get(a));
  now = 2500;
  assert.equal(s.get(a), undefined);
  const b = await s.signIn("b", "p");
  now = 2600;
  await s.signIn("c", "p");
  now = 2700;
  await s.signIn("d", "p");
  assert.equal(s.get(b), undefined);
  assert.deepEqual(out, ["a", "b"]);
});
