// Site configuration for Lambton County Library, which moved to Innovative's Vega Discover
// (backed by Sierra) in late October 2026. Values come from the portal's config.js and
// the API's own dictionaries (2026-11).

export const SITE = {
  // The portal's hostname. The API identifies the library by it (iii-customer-domain).
  portalDomain: "lcl.ca.iiivega.com",
  apiUrl: "https://ca.iiivega.com",
  // Keycloak: realm is the portal hostname's first label; the web app is the public
  // "convergence" client.
  authUrl: "https://auth.ca.iiivega.com/auth/realms/lcl/protocol/openid-connect",
  clientId: "convergence",
} as const;

// Sierra location codes from GET api/search-result/customer/locations. Codes 1 and 2 are
// the system itself; 29-31 ("Zfuture Library n") are placeholders. Neither is a branch.
export const BRANCHES: { code: string; name: string }[] = [
  ["3", "Alvinston Library"],
  ["4", "Arkona Library"],
  ["5", "Brigden Library"],
  ["6", "Bright's Grove Library"],
  ["7", "Camlachie Library"],
  ["8", "Clearwater Library"],
  ["9", "Corunna Library"],
  ["10", "Courtright Library"],
  ["11", "Florence Library"],
  ["12", "Forest Library"],
  ["13", "Grand Bend Library"],
  ["14", "Inwood Library"],
  ["15", "Lambton County Archives"],
  ["16", "Library Headquarters"],
  ["17", "Mooretown Library"],
  ["18", "Oil Springs Library"],
  ["19", "Petrolia Library"],
  ["20", "Point Edward Library"],
  ["21", "Port Franks Library"],
  ["22", "Port Lambton Library"],
  ["23", "Sarnia Library"],
  ["24", "Sombra Library"],
  ["25", "Thedford Library"],
  ["26", "Watford Library"],
  ["27", "Wilkesport Library"],
  ["28", "Wyoming Library"],
].map(([code, name]) => ({ code, name }));

const NAMES = new Map(BRANCHES.map((b) => [b.code, b.name]));
export const branchName = (code: string | undefined): string | undefined => (code ? (NAMES.get(code) ?? code) : undefined);

// Vega material types for Libby/OverDrive content (Ebook, Eaudiobook, Emagazine). Vega
// counts these as held at every branch, so a branch filter leaves them out.
export const ELECTRONIC_MATERIAL_TYPES = ["36", "41", "50"];

// Pickup locations offered by the hold form (POST gates/request-form), 2026-11. place_hold
// re-reads the live list for the record, so this is only for list_branches.
export const PICKUP_LOCATIONS = BRANCHES.filter((b) => !["6", "15", "17"].includes(b.code));

// Borrowing rules from the Circulation Policy (R02.02, rev. Aug 2023). The server enforces
// these; they're here so the model can explain a refusal or plan ahead instead of guessing.
export const LOAN_RULES =
  "Library rules: items can be renewed up to a maximum of three loan periods; an item another patron " +
  "has on hold cannot be renewed; items 30 days overdue are treated as lost and a replacement fee is invoiced.";

export const HOLD_RULES =
  "Library rules: at most 40 holds on physical items per card at once; a ready hold is kept for pickup for 7 days.";

// Opening hours aren't in Vega; the library's main website lists every branch on one page.
export const HOURS_URL = "https://www.lclibrary.ca/visit/locations-and-hours/";
