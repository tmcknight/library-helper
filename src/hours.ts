// Branch opening hours. Iguana doesn't know them; they live in a table on the library's
// main website (eSolutionsGroup CMS), which staff edit for seasonal changes and closures.

import { BRANCHES, HOURS_URL } from "./lambton.ts";

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export interface BranchHours {
  name: string; // as shown on the website, e.g. "Port Lambton"
  code?: string; // catalogue location code, when the branch has one
  note?: string; // e.g. "Temporarily closed"
  url?: string;
  hours: Record<Weekday, string | null>; // "10AM - 3PM", null = closed
}

const CACHE_TTL_MS = 60 * 60 * 1000;

function cellText(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s-])(\S)/g, (_, sep, c) => sep + c.toUpperCase());

// "Port Lambton" -> "LCL/PTLA", via the catalogue's "Port Lambton Branch".
const CODES = new Map(BRANCHES.map((b) => [b.name.replace(/ Branch$/, "").toLowerCase(), b.code]));

export function parseHoursTable(html: string, baseUrl = HOURS_URL): BranchHours[] {
  const table = html.match(/<table[^>]*>(?:(?!<\/table>)[\s\S])*?Hours of Operation[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error("hours table not found on the library website");
  const tbody = table.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? table;

  const branches: BranchHours[] = [];
  for (const [, row] of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1]);
    if (cells.length !== 1 + WEEKDAYS.length) continue;
    const [first, ...days] = cells;

    const link = first.match(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const name = titleCase(cellText(link?.[2] ?? first));
    const note = link ? cellText(first.replace(link[0], "")) : "";

    branches.push({
      name,
      code: CODES.get(name.toLowerCase()),
      ...(note && { note }),
      ...(link && { url: new URL(link[1], baseUrl).toString() }),
      hours: Object.fromEntries(
        WEEKDAYS.map((d, i) => [d, cellText(days[i]).replace(/\s*-\s*/, " - ") || null]),
      ) as Record<Weekday, string | null>,
    });
  }
  if (!branches.length) throw new Error("hours table on the library website has no branch rows");
  return branches;
}

let cache: { at: number; branches: Promise<BranchHours[]> } | null = null;

export function fetchBranchHours(): Promise<BranchHours[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.branches;
  const branches = (async () => {
    const res = await fetch(HOURS_URL, { headers: { "User-Agent": "Mozilla/5.0 (library-helper MCP)" } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} fetching branch hours`);
    return parseHoursTable(await res.text());
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
