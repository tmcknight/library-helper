import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHoursPage, libraryToday } from "../src/hours.ts";

// Four branch sections from lclibrary.ca/visit/locations-and-hours/ (2026-11): a normal
// one, a closed one, one with a wrong link, and Sarnia's differently-built heading.
const html = readFileSync(new URL("fixtures/hours.html", import.meta.url), "utf8");

test("hours: one entry per branch section, mapped to catalogue codes", () => {
  const branches = parseHoursPage(html);
  assert.deepEqual(
    branches.map((b) => [b.name, b.code]),
    [
      ["Alvinston Library", "3"],
      ["Bright's Grove Library", "6"],
      ["Inwood Library", "14"],
      ["Sarnia Library", "23"],
    ],
  );

  const alvinston = branches[0];
  assert.equal(alvinston.url, "https://www.lclibrary.ca/visit/locations-and-hours/alvinston-library/");
  assert.equal(alvinston.address, "3251 River St, Alvinston, Ontario, N0N 1A0");
  assert.equal(alvinston.phone, "519-898-2921");
  assert.equal(alvinston.note, undefined);
  assert.deepEqual(alvinston.hours, {
    monday: "10AM - 3PM",
    tuesday: "3PM - 8PM",
    wednesday: null,
    thursday: "10AM - 3PM",
    friday: "3PM - 8PM",
    saturday: "10AM - 1PM",
    sunday: null,
  });

  const sarnia = branches[3];
  assert.equal(sarnia.hours.sunday, "2PM - 5PM");
  assert.equal(sarnia.url, undefined);
});

test("hours: closure notes and mislinked branches", () => {
  const branches = parseHoursPage(html);
  const brightsGrove = branches.find((b) => b.code === "6")!;
  assert.equal(brightsGrove.note, "Temporarily closed");
  assert.ok(Object.values(brightsGrove.hours).every((h) => h === null));

  // The site links Inwood's heading to Grand Bend's page; don't pass that on.
  const inwood = branches.find((b) => b.code === "14")!;
  assert.equal(inwood.url, undefined);
  assert.equal(inwood.hours.tuesday, "4PM - 8PM");
});

test("hours: a page without branch sections is an error, not an empty list", () => {
  assert.throws(() => parseHoursPage("<html><body>maintenance</body></html>"), /no branch hours found/);
});

test("libraryToday uses Toronto time", () => {
  // 02:30 UTC Tuesday = 22:30 Monday EDT
  assert.deepEqual(libraryToday(new Date("2026-10-13T02:30:00Z")), {
    date: "2026-10-12",
    weekday: "monday",
    time: "22:30",
  });
});
