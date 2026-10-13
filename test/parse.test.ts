import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseSearchResponse, parseRecord, parseHoldings } from "../src/parse.ts";

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), "utf8");

test("search: total, clusters and records", () => {
  const r = parseSearchResponse(fixture("search.xml"));
  assert.equal(r.total, 86);
  assert.equal(r.hits.length, 10);

  const cluster = r.hits[0];
  assert.equal(cluster.kind, "cluster");
  assert.equal(cluster.recordId, "1.12639");
  assert.deepEqual(cluster.authors, ["Collins, Suzanne."]);
  assert.ok(cluster.clusteredRecordIds!.includes("1.819720"));
  assert.ok(cluster.versions!.some((v) => v.label === "DVD"));
  assert.ok(!cluster.versions!.some((v) => v.recordType === "*"));

  const rec = r.hits[1];
  assert.equal(rec.kind, "record");
  assert.equal(rec.recordId, "1.750133");
  assert.equal(rec.title, "The hunger games, the ballad of songbirds and snakes");
  assert.equal(rec.authors.length, 6);
  assert.equal(rec.year, "2024");
  assert.equal(rec.materialType, "AVDVD");
  assert.equal(rec.reservable, true);
  assert.ok(rec.branches!.some((b) => b.code === "LCL/SARN" && b.available));
});

test("record: full details", () => {
  const r = parseRecord(fixture("record.xml"));
  assert.equal(r.recordId, "1.750133");
  assert.match(r.title, /ballad of songbirds and snakes/);
  assert.ok(!r.title.includes("<q>"));
  assert.ok(r.authors.includes("Collins, Suzanne."));
  assert.ok(r.subjects.includes("Contests -- Drama"));
  assert.ok(r.genres.includes("Feature films"));
  assert.match(r.coverUrl!, /^https:\/\/secure\.syndetics\.com/);
});

test("holdings: one entry per copy", () => {
  const items = parseHoldings(fixture("holdings.xml"));
  assert.equal(items.length, 6);
  assert.deepEqual(items[0], {
    location: "Alvinston Branch",
    locationCode: "LCL/ALVI",
    shelfmark: "Alvinston Branch AVDVD HUNGE 1 DISC",
    barcode: "20210011987048",
    status: "inthelibrary",
    available: true,
    holds: 0,
    dueDate: undefined,
  });
});

test("holdings: due date split out of onloan status", () => {
  const xml = fixture("holdings.xml").replace("<![CDATA[inthelibrary]]>", "<![CDATA[onloan_20/10/2026]]>");
  const [first] = parseHoldings(xml);
  assert.equal(first.status, "onloan");
  assert.equal(first.dueDate, "2026-10-20");
});
