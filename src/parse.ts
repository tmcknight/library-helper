// Parsers for the SRU-like XML returned by Proxy.SearchRequest.cls.

import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  cdataPropName: "__cdata", // keeps multi-CDATA nodes (e.g. one author per CDATA) as arrays
  isArray: (name) => ["record", "Element", "Item", "ShelfmarkData", "Version", "BibId"].includes(name),
});

type Node = any;

// All text values of a node, one per CDATA section.
function texts(node: Node): string[] {
  if (node == null) return [];
  if (typeof node === "string") return [node];
  if (Array.isArray(node)) return node.flatMap(texts);
  if (node.__cdata !== undefined) return texts(node.__cdata);
  if (node["#text"] !== undefined) return texts(node["#text"]);
  return [];
}

function text(node: Node): string {
  return clean(texts(node).join(" "));
}

// Strip the OPAC's display markup (<q> hit highlighting, <br>) and collapse whitespace.
export function clean(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

// Catalogue (ISBD) punctuation left dangling at the end of a field: "Title :", "2024.;"
function trimPunct(s: string): string {
  return s.replace(/[\s:;,/=.]+$/, "");
}

function list(node: Node): string[] {
  return texts(node).map(clean).filter(Boolean);
}

function elements(bibData: Node): Map<string, Node> {
  const map = new Map<string, Node>();
  for (const el of bibData?.Element ?? []) map.set(String(el.Label), el.Data);
  return map;
}

// "Contents A" / cover data carries "MATTYPE=AVDVD!!!###!!!BIBTYPE=gm" style flags.
function materialType(raw: string): string | undefined {
  return raw.match(/MATTYPE=([^!]+)/)?.[1];
}

export interface BranchSummary {
  location: string;
  code: string;
  shelfmark: string;
  status: string;
  available: boolean;
}

export interface SearchHit {
  recordId: string;
  kind: "record" | "cluster";
  title: string;
  authors: string[];
  year?: string;
  materialType?: string;
  availability?: string;
  reservable?: boolean;
  branches?: BranchSummary[];
  // Clusters group several editions/formats; place holds on one of the version's records.
  versions?: ClusterVersion[];
  clusteredRecordIds?: string[];
}

export interface ClusterVersion {
  label: string;
  recordType: string;
  records?: Omit<SearchHit, "kind" | "title" | "authors">[];
}

export interface SearchResult {
  total: number;
  hits: SearchHit[];
}

function branchSummaries(doc: Node): BranchSummary[] {
  return (doc?.HoldingsSummary?.ShelfmarkData ?? [])
    .map((s: Node) => ({
      location: text(s.LocationWording),
      code: text(s.Scope),
      shelfmark: text(s.Shelfmark),
      status: text(s.StatusSummary),
      available: text(s.Available) === "1",
    }))
    .filter((b: BranchSummary) => b.location); // on-order records carry a placeholder row with no branch
}

export function parseSearchResponse(xml: string): SearchResult {
  const root = parser.parse(xml).searchRetrieveResponse ?? {};
  const hits: SearchHit[] = [];
  for (const rec of root.records?.record ?? []) {
    const data = rec.recordData ?? {};
    if (data.ClusterDocument) {
      const doc = data.ClusterDocument;
      const els = elements(doc);
      const vs = doc.VersionSummary ?? {};
      hits.push({
        recordId: String(doc.Id),
        kind: "cluster",
        title: trimPunct(text(els.get("BriefMainTitle"))),
        authors: list(els.get("BriefAuthor")),
        versions: (vs.Version ?? [])
          .map((v: Node) => ({ label: text(v.Wording), recordType: text(v.RecordType) }))
          .filter((v: { recordType: string }) => !/^\*+$/.test(v.recordType)),
        clusteredRecordIds: list(vs.ClusteredRecords?.BibId),
      });
    } else if (data.BibDocument) {
      const doc = data.BibDocument;
      const els = elements(doc.BibData);
      hits.push({
        recordId: String(doc.Id),
        kind: "record",
        title: trimPunct(text(els.get("BriefMainTitle"))),
        authors: list(els.get("BriefAuthor")),
        year: trimPunct(text(els.get("BriefExtract")).replace(/[[\]]/g, "")) || undefined,
        materialType: text(doc.DisplayMaterialType) || materialType(text(els.get("Contents A"))),
        availability: text(els.get("BriefAvailability")) || undefined,
        reservable: text(doc.Reservable) === "1",
        branches: branchSummaries(doc),
      });
    }
  }
  return { total: Number(text(root.numberOfRecords)) || 0, hits };
}

export interface RecordDetail {
  recordId: string;
  title: string;
  authors: string[];
  imprint?: string;
  description?: string;
  summary?: string;
  notes: string[];
  genres: string[];
  subjects: string[];
  identifiers: string[];
  materialType?: string;
  reservable: boolean;
  coverUrl?: string;
  branches: BranchSummary[];
}

export function parseRecord(xml: string): RecordDetail {
  const root = parser.parse(xml).searchRetrieveResponse ?? {};
  const doc = root.records?.record?.[0]?.recordData?.BibDocument;
  if (!doc) throw new Error("record not found");
  const els = elements(doc.BibData);
  const cover = text(els.get("FullCoverA")).split("@@@")[0];
  return {
    recordId: String(doc.Id),
    title: trimPunct(text(els.get("FullTitleAll")) || text(els.get("FullMainTitle"))),
    authors: list(els.get("FullAuthor")),
    imprint: text(els.get("FullImprint")) || undefined,
    description: text(els.get("FullContains")) || undefined,
    summary: text(els.get("FullExtract")) || undefined,
    notes: list(els.get("FullNote")),
    genres: list(els.get("FullGenre")),
    // FullKeyword entries look like "#!#.499.131593***1*Subjectbib$^Contests -- Drama^ <BR>Contests--Drama.#!#"
    subjects: texts(els.get("FullKeyword"))
      .map((k) => k.match(/\^([^^]+)\^/)?.[1]?.trim())
      .filter((s): s is string => Boolean(s)),
    identifiers: list(els.get("FullNumber")),
    materialType: text(doc.DisplayMaterialType) || undefined,
    reservable: text(doc.Reservable) === "1",
    coverUrl: cover.startsWith("http") ? cover : undefined,
    branches: branchSummaries(doc),
  };
}

export interface HoldingItem {
  location: string;
  locationCode: string;
  shelfmark: string;
  barcode: string;
  status: string; // e.g. inthelibrary, onloan
  available: boolean;
  holds: number;
  dueDate?: string;
}

export function parseHoldings(xml: string): HoldingItem[] {
  const root = parser.parse(xml).searchRetrieveResponse ?? {};
  const items = root.records?.record?.[0]?.recordData?.Items?.Item ?? [];
  return items.map((it: Node) => {
    // Status carries the due date for loaned copies: "onloan_20/10/2026" (DD/MM/YYYY).
    const [status, due] = text(it.Availability).split("_");
    const d = due?.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    return {
      location: text(it.LocationWording),
      locationCode: text(it.InstLocCode),
      shelfmark: text(it.Shelfmark),
      barcode: text(it.Barcode),
      status,
      available: text(it.AvailabilityFlag) === "1",
      holds: Number(text(it.Reservations)) || 0,
      dueDate: d ? `${d[3]}-${d[2]}-${d[1]}` : due || undefined,
    };
  });
}
