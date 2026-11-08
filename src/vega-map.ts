// Turn Vega API responses into compact tool output. Pure functions, so they can be tested
// against saved responses without a network.

import { branchName } from "./lambton.ts";

// ---- Raw shapes (only the fields we read) ---------------------------------

export interface RawEdition {
  id: string; // instance UUID
  recordId: string; // Sierra bib number
  availabilityStatus?: string;
  callNumber?: string;
  edition?: string;
  publicationDate?: string;
  publisher?: string;
  type?: string;
}

export interface RawMaterialTab {
  name: string; // "Book", "Large Print", "DVD", ...
  type: string; // "physical" | "electronic"
  availability?: { status?: { general?: string }; nonCirculating?: boolean };
  recordIds?: string[];
  locations?: { code: string; label: string; availabilityStatus: string }[];
  hasMoreLocations?: boolean;
  editions?: RawEdition[];
  itemCount?: number;
}

export interface RawFormatGroup {
  id: string;
  title: string;
  publicationDate?: string;
  primaryAgent?: { label: string };
  language?: string;
  materialTabs?: RawMaterialTab[];
}

export interface RawInstance {
  id: string;
  agent?: { item: { label: string }; linkType?: { attributes?: { role?: string } } }[];
  work?: { item: { genreForm?: string[]; summary?: { label: string }[] } }[];
  concept?: { item: { label: string } }[];
  title?: { label: string }[];
  editionStatement?: string[];
  provisionActivityStatement?: string[];
  extent?: string[];
  identifiedBy?: { type: string; value: string }[];
  intendedAudience?: unknown;
  $language?: string[];
  $publicationDate?: string[];
}

export interface RawItem {
  barcode?: string;
  location?: string;
  locationCode?: string;
  status?: string;
  itemStatusCode?: string;
  callNumber?: string;
  dueDate?: string;
  itemMaterialTypeName?: string;
  volume?: string;
}

export interface RawCheckout {
  id: string;
  renewalCount?: number;
  renewalLimit?: number;
  checkOutDate?: string;
  dueDate: string;
  vendor?: string; // "gates" = Sierra; "overdrive" = Libby e-content
  resource?: { id?: string; title?: string; materialType?: string; coverUrl?: unknown };
  canItemBeRenewed?: boolean;
  [k: string]: unknown;
}

export interface RawHold {
  id: string;
  recordId?: string;
  status?: string;
  priority?: number;
  location?: string;
  frozen?: boolean;
  neededBy?: string;
  expirationDate?: string;
  allowedActions?: string[];
  resource?: { id?: string; title?: string; materialType?: string; coverUrl?: unknown };
  [k: string]: unknown;
}

// ---- Catalogue -------------------------------------------------------------

export function searchResult(raw: { totalResults: number; totalPages: number; page: number; data: RawFormatGroup[] }) {
  return {
    total: raw.totalResults,
    page: raw.page + 1,
    totalPages: raw.totalPages,
    hits: raw.data.map((fg) => ({
      title: fg.title,
      author: fg.primaryAgent?.label,
      year: fg.publicationDate,
      language: fg.language,
      formats: (fg.materialTabs ?? []).map(format),
    })),
  };
}

function format(tab: RawMaterialTab) {
  return {
    format: tab.name,
    ...(tab.type !== "physical" && { electronic: true, note: "Libby/OverDrive title: borrow or hold it in the Libby app" }),
    status: tab.availability?.status?.general,
    copies: tab.itemCount,
    editions: (tab.editions ?? []).filter((e) => tab.type === "physical" || !e.recordId.includes(":")).map((e) => ({
      recordId: e.recordId,
      year: e.publicationDate,
      ...(e.edition && { edition: e.edition }),
      ...(e.publisher && { publisher: e.publisher }),
      callNumber: e.callNumber,
      status: e.availabilityStatus,
    })),
    branches: (tab.locations ?? []).map((l) => ({ code: l.code, name: l.label, available: l.availabilityStatus === "Available" })),
    ...(tab.hasMoreLocations && { moreBranches: true }),
  };
}

export function findEdition(fg: RawFormatGroup, recordId: string): (RawEdition & { tab: RawMaterialTab }) | undefined {
  for (const tab of fg.materialTabs ?? []) {
    const e = tab.editions?.find((x) => x.recordId === recordId);
    if (e) return { ...e, tab };
  }
  return undefined;
}

export function record(fg: RawFormatGroup, inst: RawInstance, recordId: string) {
  const ed = findEdition(fg, recordId);
  const ids = (type: string) => (inst.identifiedBy ?? []).filter((i) => i.type === type).map((i) => i.value);
  const work = inst.work?.[0]?.item;
  const otherFormats = (fg.materialTabs ?? [])
    .flatMap((t) => (t.editions ?? []).map((e) => ({ recordId: e.recordId, format: t.name, year: e.publicationDate })))
    .filter((e) => e.recordId !== recordId);
  return {
    recordId,
    title: inst.title?.[0]?.label ?? fg.title,
    contributors: (inst.agent ?? []).map((a) => ({ name: a.item.label, role: a.linkType?.attributes?.role })),
    format: ed?.tab.name,
    edition: inst.editionStatement?.[0],
    published: inst.provisionActivityStatement?.[0],
    year: inst.$publicationDate?.[0],
    language: inst.$language?.[0],
    extent: inst.extent?.join(" "),
    callNumber: ids("shelfMark")[0] ?? ed?.callNumber,
    isbn: ids("isbn"),
    upc: ids("upc"),
    summary: work?.summary?.map((s) => s.label).join("\n\n"),
    genres: work?.genreForm,
    subjects: (inst.concept ?? []).map((c) => c.item.label),
    status: ed?.availabilityStatus,
    branches: ed ? format(ed.tab).branches : [],
    ...(otherFormats.length && { otherFormats }),
  };
}

export function items(raw: RawItem[]) {
  return raw.map((i) => ({
    branch: i.location ?? branchName(i.locationCode),
    branchCode: i.locationCode,
    callNumber: i.callNumber,
    ...(i.volume && { volume: i.volume }),
    status: i.status,
    available: i.itemStatusCode === "1" || i.itemStatusCode === "19", // In, Shelving
    ...(i.dueDate && { dueDate: i.dueDate }),
    barcode: i.barcode,
  }));
}

// ---- Account ---------------------------------------------------------------

export function loan(c: RawCheckout, now = Date.now()) {
  const physical = (c.vendor ?? "gates") === "gates";
  return {
    checkoutId: c.id,
    title: c.resource?.title,
    format: c.resource?.materialType,
    source: physical ? "library" : c.vendor,
    checkedOut: c.checkOutDate,
    dueDate: c.dueDate,
    overdue: Date.parse(c.dueDate) < now,
    ...(physical
      ? { renewals: c.renewalCount, renewalLimit: c.renewalLimit, canRenew: Boolean(c.canItemBeRenewed) }
      : { canRenew: false, note: "Libby/OverDrive loan: returns itself on the due date; renew in the Libby app" }),
  };
}

// Sierra hold status codes, as the portal reads them (j5.z in the bundle).
const HOLD_STATUS: Record<string, string> = {
  i: "ready for pickup",
  b: "ready for pickup",
  j: "ready for pickup",
  t: "in transit",
  s: "sent by mail",
  "0": "waiting",
  "": "pending",
};

export function hold(h: RawHold) {
  const code = h.status ?? "";
  return {
    holdId: h.id,
    title: h.resource?.title,
    format: h.resource?.materialType,
    recordId: h.recordId,
    status: HOLD_STATUS[code] ?? code,
    readyForPickup: ["i", "b", "j"].includes(code),
    ...(h.priority != null && { queuePosition: h.priority }),
    pickupLocation: h.location ? { code: h.location, name: branchName(h.location) } : undefined,
    ...(h.frozen && { frozen: true }),
    ...(h.expirationDate && { expires: h.expirationDate }),
    ...(h.neededBy && { neededBy: h.neededBy }),
    allowedActions: h.allowedActions,
  };
}

// Shapes read from the portal bundle (the fines page and the reading-history bookshelf),
// 2026-11; the test card had no fines and reading history off, so no live sample yet.
export interface RawFine {
  id: string;
  outstandingAmount?: number;
  type?: string; // display text, e.g. "Overdue"
  creationDate?: string;
  description?: string;
  resource?: { id?: string; title?: string; materialType?: string; coverUrl?: unknown };
}

export function fines(raw: { totalOutstandingAmount?: number; data?: RawFine[] }) {
  return {
    totalOutstanding: raw.totalOutstandingAmount ?? 0,
    fines: (raw.data ?? []).map((f) => ({
      fineId: f.id,
      title: f.resource?.title,
      format: f.resource?.materialType,
      type: f.type,
      ...(f.description && { description: f.description }),
      amount: f.outstandingAmount ?? 0,
      date: f.creationDate,
    })),
  };
}

// A reading-history entry is a format group with the checkout date mixed in.
export interface RawHistoryItem {
  id: string;
  title?: string;
  primaryAgent?: { label?: string };
  materialTabs?: RawMaterialTab[];
  checkoutDate?: string;
  format?: unknown;
  readingHistoryItemId?: string;
  [k: string]: unknown;
}

export function historyItem(h: RawHistoryItem) {
  const tab = h.materialTabs?.[0];
  const recordId = tab?.editions?.find((e) => /^\d+$/.test(e.recordId))?.recordId;
  return {
    title: h.title,
    author: h.primaryAgent?.label,
    format: typeof h.format === "string" && h.format ? h.format : tab?.name,
    checkedOut: h.checkoutDate,
    ...(recordId && { recordId }),
  };
}

export function stripCovers<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripCovers) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "coverUrl").map(([k, x]) => [k, stripCovers(x)])) as T;
  }
  return v;
}
