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
  assert.equal(hit.isbn, "9780141354965");
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
  assert.deepEqual(map.stripCovers({ a: 1, coverUrl: "x", b: [{ coverUrl: {}, cover: "y", c: 2 }] }), { a: 1, b: [{ c: 2 }] });
});

test("cover: the medium Syndetics link, without its caption fallback", () => {
  const syn = (size: string) =>
    `https://secure.syndetics.com/index.aspx?isbn=9780316556347/${size}.gif&client=lclvega&type=unbound&nicaption=Circe%1FMiller%1FBook`;
  assert.equal(
    map.cover({ small: syn("sc"), medium: syn("mc"), large: syn("lc") }),
    "https://secure.syndetics.com/index.aspx?isbn=9780316556347%2Fmc.gif&client=lclvega&type=unbound",
  );
  assert.equal(map.cover({ large: syn("lc") })?.includes("lc.gif"), true);
  // As loans and holds send them, with the ampersands HTML-escaped.
  assert.equal(
    map.cover({ medium: syn("mc").replaceAll("&", "&amp;") }),
    "https://secure.syndetics.com/index.aspx?isbn=9780316556347%2Fmc.gif&client=lclvega&type=unbound",
  );
  assert.equal(map.cover({ medium: "https://evil.example/x.gif" }), undefined);
  assert.equal(map.cover({ medium: "http://secure.syndetics.com/x" }), undefined);
  assert.equal(map.cover(undefined), undefined);
  assert.equal(map.cover("nope"), undefined);
  assert.equal(map.loan({ id: "1", dueDate: "2026-11-20", resource: { title: "X", coverUrl: { medium: syn("mc") } } }).cover?.startsWith("https://secure.syndetics.com/"), true);
  assert.equal(map.hold({ id: "h", resource: { coverUrl: { medium: syn("mc") } } }).cover?.includes("isbn=9780316556347"), true);
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

test("list: names the For Later list and counts items", () => {
  assert.deepEqual(map.list({ id: "a", type: "FOR_LATER", items: { totalResults: 0 } }), { listId: "a", name: "For Later", type: "for-later", count: 0 });
  assert.deepEqual(map.list({ id: "b", name: "Personal reading list", type: "REGULAR", items: { totalResults: 8 } }), {
    listId: "b",
    name: "Personal reading list",
    type: "regular",
    count: 8,
  });
});

test("listItems: hits with the saved edition's record id", () => {
  const fg = fixture("search.json").data[0];
  const r = map.listItems({ totalResults: 2, totalPages: 1, page: 0, data: [{ ...fg, personalLists: [{ recordId: "33990", listIds: ["b"] }] }, fg] });
  assert.equal(r.page, 1);
  assert.equal(r.items[0].id, fg.id);
  assert.equal(r.items[0].title, "Watership Down");
  assert.equal(r.items[0].recordId, "33990");
  // Without personalLists, fall back to the first Sierra edition.
  assert.match(r.items[1].recordId!, /^\d+$/);
});

test("listItemsAt: keeps titles on the shelf at the branch, in list order, with the saved edition", () => {
  const tab = (code: string, status: string) => ({
    name: "Book",
    type: "physical",
    editions: [{ id: "i", recordId: "100" }],
    locations: [{ code, label: "Petrolia Library", availabilityStatus: status }],
  });
  const list = [
    { id: "b", title: "B", personalLists: [{ recordId: "200" }] },
    { id: "a", title: "A" },
    { id: "c", title: "C" },
  ];
  const found = [
    { id: "a", title: "A", materialTabs: [tab("19", "Available")] },
    { id: "b", title: "B", materialTabs: [tab("19", "Available")] },
    { id: "c", title: "C", materialTabs: [tab("19", "Unavailable")] },
  ];
  const ok = new Set(found.filter((fg) => map.availableAt(fg, "19")).map((fg) => fg.id));
  const r = map.listItemsAt(list, found, ok);
  assert.deepEqual(r.items.map((i) => [i.id, i.recordId]), [["b", "200"], ["a", "100"]]);
  assert.equal(r.total, 2);
  assert.equal(map.availableAt(found[0], "3"), false);
  // Cut-short list that doesn't name the branch: unknown, and which format to look up.
  const cut = { id: "d", title: "D", materialTabs: [{ ...tab("8", "Available"), hasMoreLocations: true }] };
  assert.equal(map.availableAt(cut, "19"), undefined);
  assert.deepEqual(map.unlistedTabs(cut, "19"), ["Book"]);
});
