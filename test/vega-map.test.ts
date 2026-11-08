import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as map from "../src/vega-map.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8"));

test("search: works with formats, editions and branch availability", () => {
  const r = map.searchResult(fixture("search.json"));
  assert.equal(r.page, 1);
  assert.ok(r.total >= r.hits.length);

  const hit = r.hits[0];
  assert.equal(hit.title, "Watership Down");
  const book = hit.formats.find((f) => f.format === "Book")!;
  assert.equal(book.electronic, undefined);
  assert.ok(book.editions.length > 0);
  for (const e of book.editions) assert.match(e.recordId, /^\d+$/);
  assert.ok(book.branches.every((b) => /^\d+$/.test(b.code) && typeof b.available === "boolean"));

  // Libby titles are flagged, and their "uuid:overdrive" ids aren't offered as record ids.
  const audio = hit.formats.find((f) => f.electronic)!;
  assert.match(audio.note!, /Libby/);
  assert.deepEqual(audio.editions, []);
});

test("record: bibliographic detail from the instance, branches from the format group", () => {
  const rec = map.record(fixture("format-group.json"), fixture("instance.json"), "57455");
  assert.equal(rec.title, "Project Hail Mary : a novel");
  assert.equal(rec.format, "Book");
  assert.deepEqual(rec.contributors, [{ name: "Weir, Andy.", role: "aut" }]);
  assert.equal(rec.callNumber, "FIC WEIR");
  assert.deepEqual(rec.isbn, ["9780593135204", "0593135202"]);
  assert.ok(rec.subjects.includes("Astronauts--Fiction"));
  assert.match(rec.summary!, /^Ryland Grace/);
  assert.ok(rec.branches.some((b) => b.name === "Clearwater Library"));
  assert.deepEqual(
    rec.otherFormats?.map((f) => f.format),
    ["Large Print", "Ebook"],
  );
});

test("findEdition: locates a record id in any format", () => {
  const fg = fixture("format-group.json");
  assert.equal(map.findEdition(fg, "62392")?.tab.name, "Large Print");
  assert.equal(map.findEdition(fg, "1"), undefined);
});

test("items: one entry per copy with availability", () => {
  const items = map.items(fixture("items.json"));
  assert.equal(items.length, 7);
  const clearwater = items.find((i) => i.branchCode === "8")!;
  assert.deepEqual(clearwater, {
    branch: "Clearwater Library",
    branchCode: "8",
    callNumber: "FIC WEIR",
    status: "In",
    available: true,
    barcode: "20210011223386",
  });
  const out = items.find((i) => i.status === "Out")!;
  assert.equal(out.available, false);
  assert.match(out.dueDate!, /^\d{4}-\d{2}-\d{2}$/);
});

test("loan: library vs Libby checkouts", () => {
  const now = Date.parse("2026-11-20T00:00:00Z");
  const physical = map.loan(
    {
      id: "186035",
      renewalCount: 1,
      renewalLimit: 3,
      checkOutDate: "2026-11-04T15:14:03Z",
      dueDate: "2026-11-26T04:59:59Z",
      vendor: "gates",
      resource: { title: "The nightingale", materialType: "Book" },
      canItemBeRenewed: true,
    },
    now,
  );
  assert.equal(physical.source, "library");
  assert.equal(physical.overdue, false);
  assert.equal(physical.canRenew, true);
  assert.equal(physical.renewals, 1);

  const libby = map.loan(
    { id: "abc-uuid", dueDate: "2026-11-11T02:56:24Z", vendor: "overdrive", renewalCount: 0, renewalLimit: 0, resource: { title: "Pax" } },
    now,
  );
  assert.equal(libby.source, "overdrive");
  assert.equal(libby.canRenew, false);
  assert.equal(libby.overdue, true);
  assert.equal("renewals" in libby, false);
});

test("hold: Sierra status codes and pickup branch names", () => {
  const ready = map.hold({ id: "h1", status: "i", priority: 1, location: "19", resource: { title: "X" } });
  assert.equal(ready.status, "ready for pickup");
  assert.equal(ready.readyForPickup, true);
  assert.deepEqual(ready.pickupLocation, { code: "19", name: "Petrolia Library" });

  const waiting = map.hold({ id: "h2", status: "0", priority: 4, frozen: true });
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.readyForPickup, false);
  assert.equal(waiting.queuePosition, 4);
  assert.equal(waiting.frozen, true);
});

test("stripCovers removes cover URLs at any depth", () => {
  assert.deepEqual(map.stripCovers({ a: 1, coverUrl: "x", b: [{ coverUrl: {}, c: 2 }] }), { a: 1, b: [{ c: 2 }] });
});

test("fines: total and one row per charge", () => {
  const f = map.fines({
    totalOutstandingAmount: 2.5,
    data: [
      { id: "f1", outstandingAmount: 2.5, type: "Overdue", creationDate: "2026-10-30", resource: { title: "Dune", materialType: "Book", coverUrl: { small: "x" } } },
      { id: "f2", outstandingAmount: 0, type: "Lost card", description: "Replacement card" },
    ],
  });
  assert.equal(f.totalOutstanding, 2.5);
  assert.deepEqual(f.fines[0], { fineId: "f1", title: "Dune", format: "Book", type: "Overdue", amount: 2.5, date: "2026-10-30" });
  assert.equal(f.fines[1].description, "Replacement card");
  assert.equal(f.fines[1].title, undefined);
  assert.deepEqual(map.fines({}), { totalOutstanding: 0, fines: [] });
});

test("historyItem: title, author, format and a Sierra record id from the format group", () => {
  const fg = fixture("format-group.json");
  const h = map.historyItem({ ...fg, checkoutDate: "2026-09-01", readingHistoryItemId: "rh1" });
  assert.equal(h.title, fg.title);
  assert.equal(h.author, fg.primaryAgent?.label);
  assert.equal(h.format, fg.materialTabs[0].name);
  assert.equal(h.checkedOut, "2026-09-01");
  assert.match(h.recordId!, /^\d+$/);

  // Libby-only entries have no Sierra record id.
  const libby = map.historyItem({ id: "x", title: "Y", format: "eBook", materialTabs: [{ name: "eBook", type: "electronic", editions: [{ id: "i", recordId: "abc:overdrive" }] }] });
  assert.equal(libby.recordId, undefined);
  assert.equal(libby.format, "eBook");
});
