// Branch opening hours. Vega doesn't know them; the library's main website (GovStack /
// Umbraco) lists every branch on one page, which staff edit for seasonal changes and
// closures. Each branch is a "usn_cmp_pods" section: an <h1> with the name, the address
// and phone, then "Hours of Operation" rows like "Monday 10:00 a.m. - 3:00 p.m.", or a
// single "Temporarily Closed".

import { BRANCHES, HOURS_URL } from "./lambton.ts";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface BranchHours {
  name: string; // e.g. "Port Lambton Library"
  code?: string; // catalogue location code, when the branch has one
  note?: string; // e.g. "Temporarily closed"
  address?: string;
  phone?: string;
  url?: string;
  hours: Record<Weekday, string | null>; // "10AM - 3PM", null = closed
}

const CACHE_TTL_MS = 60 * 60 * 1000;

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&#x27;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// "10:00 a.m. - 3:00 p.m." -> "10AM - 3PM"; "12:30 p.m." -> "12:30PM".
function compactTime(s: string): string {
  return s
    .replace(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/gi, (_, h, m, ap) => `${h}${m && m !== "00" ? `:${m}` : ""}${ap.toUpperCase()}M`)
    .replace(/\s*[-\u2013]\s*/, " - ");
}

const slug = (s: string) => s.toLowerCase().replace(/'/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const CODES = new Map(BRANCHES.map((b) => [slug(b.name), b.code]));

export function parseHoursPage(html: string, baseUrl = HOURS_URL): BranchHours[] {
  const branches: BranchHours[] = [];
  for (const section of html.split(/<section class="content component usn_cmp_pods/).slice(1)) {
    const h1 = section.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    const hoursAt = section.search(/Hours of Operation/i);
    if (!h1 || hoursAt < 0) continue;
    const name = text(h1);

    // Some links on the page point at the wrong branch (Inwood -> grand-bend-library);
    // keep a link only when it matches the name.
    const href = h1.match(/href="([^"]+)"/)?.[1];
    const url = href && href.includes(slug(name)) ? new URL(href, baseUrl).toString() : undefined;

    const before = section.slice(0, hoursAt);
    const phone = before.match(/href="tel:[^"]*"[^>]*>([^<]+)</)?.[1]?.trim();
    const address = [...before.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => text(m[1])).find((t) => t && t !== phone);

    const hours = Object.fromEntries(WEEKDAYS.map((d) => [d, null])) as Record<Weekday, string | null>;
    const notes: string[] = [];
    for (const [, row] of section.slice(hoursAt).matchAll(/<p class="title base-heading">([\s\S]*?)<\/p>/g)) {
      const t = text(row);
      const m = t.match(/^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b\s*(.*)$/i);
      if (!m) {
        if (t) notes.push(t.charAt(0) + t.slice(1).toLowerCase());
        continue;
      }
      const when = m[2].trim();
      hours[m[1].toLowerCase() as Weekday] = !when || /^closed$/i.test(when) ? null : compactTime(when);
    }

    branches.push({
      name,
      code: CODES.get(slug(name)),
      ...(notes.length && { note: notes.join("; ") }),
      ...(address && { address }),
      ...(phone && { phone }),
      ...(url && { url }),
      hours,
    });
  }
  if (!branches.length) throw new Error("no branch hours found on the library website (page layout changed?)");
  return branches;
}

let cache: { at: number; branches: Promise<BranchHours[]> } | null = null;

export function fetchBranchHours(): Promise<BranchHours[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.branches;
  const branches = (async () => {
    const res = await fetch(HOURS_URL, { headers: { "User-Agent": "Mozilla/5.0 (library-helper MCP)" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching branch hours`);
    return parseHoursPage(await res.text());
  })();
  cache = { at: Date.now(), branches };
  branches.catch(() => (cache = null)); // don't cache failures
  return branches;
}

// The library's local date and weekday, so "open now?" doesn't depend on the server's timezone.
export function libraryToday(now = new Date()): { date: string; weekday: Weekday; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Toronto",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday.toLowerCase() as Weekday,
    time: `${parts.hour}:${parts.minute}`,
  };
}
