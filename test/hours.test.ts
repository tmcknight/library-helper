import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHoursTable, libraryToday } from "../src/hours.ts";

const html = readFileSync(new URL("fixtures/hours.html", import.meta.url), "utf8");

test("hours: one row per branch, mapped to catalogue codes", () => {
  const branches = parseHoursTable(html);
  assert.equal(branches.length, 24);

  const alvinston = branches[0];
  assert.equal(alvinston.name, "Alvinston");
  assert.equal(alvinston.code, "LCL/ALVI");
  assert.equal(alvinston.url, "https://www.lclibrary.ca/en/visit/alvinston-library.aspx");
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

  const grandBend = branches.find((b) => b.name === "Grand Bend")!;
  assert.equal(grandBend.code, "LCL/GRBE");

  const sarnia = branches.find((b) => b.code === "LCL/SARN")!;
  assert.equal(sarnia.hours.sunday, "2PM - 5PM");
});

test("hours: closure notes, and branches without a catalogue code", () => {
  const branches = parseHoursTable(html);
  const brightsGrove = branches.find((b) => b.name === "Bright's Grove")!;
  assert.equal(brightsGrove.code, undefined);
  assert.equal(brightsGrove.note, "Temporarily closed");

  const mooretown = branches.find((b) => b.code === "LCL/MOOR")!;
  assert.equal(mooretown.note, "Temporarily closed");
  assert.equal(mooretown.hours.wednesday, "4PM - 8PM");
});

test("hours: missing table is an error, not an empty list", () => {
  assert.throws(() => parseHoursTable("<html><body>maintenance</body></html>"), /hours table not found/);
});

test("libraryToday uses Toronto time", () => {
  // 02:30 UTC Tuesday = 22:30 Monday EDT
  assert.deepEqual(libraryToday(new Date("2026-10-13T02:30:00Z")), {
    date: "2026-10-12",
    weekday: "monday",
    time: "22:30",
  });
});
