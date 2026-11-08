import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { handleApi, HttpError, serveApi, serveStatic } from "../src/web.ts";
import type { LibraryClient } from "../src/web.ts";
import { VegaError } from "../src/vega.ts";

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
    fines: rec("fines", { totalOutstandingAmount: 0, data: [] }),
    loanHistory: rec("loanHistory", { enabled: false }),
    ...over,
  } as unknown as LibraryClient;
  return { client, calls };
}

const u = (path: string) => new URL(path, "http://x");

test("search: passes validated params through with defaults", async () => {
  const { client, calls } = fakeClient();
  await handleApi(client, "GET", u("/api/search?q=hail+mary&index=title&sort=newest&page=2"), undefined);
  assert.deepEqual(calls, [["search", [{ query: "hail mary", index: "title", sort: "newest", page: 2, limit: 20 }]]]);
});

test("search: rejects missing query and unknown index/sort/page", async () => {
  const { client } = fakeClient();
  for (const path of ["/api/search", "/api/search?q=x&index=isbn", "/api/search?q=x&sort=random", "/api/search?q=x&page=0", "/api/search?q=x&limit=500"]) {
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

async function withServer(client: LibraryClient, fn: (base: string) => Promise<void>) {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "GET" && (await serveStatic(path, res))) return;
    await serveApi(client, req, res);
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
    assert.match(res.headers.get("content-security-policy")!, /script-src 'self'/);
    assert.match(await res.text(), /<script type="module" src="app.js">/);
    assert.equal((await fetch(`${base}/app.js`)).headers.get("content-type"), "text/javascript; charset=utf-8");
  });
});
