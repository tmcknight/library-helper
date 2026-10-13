// Site configuration for Lambton County Library, taken from the live OPAC's
// Service.Search.cls metadata and Config.srch_resv_* settings (2026-10).

import type { ReserveConfig } from "./iguana.ts";

const NAMES: Record<string, string> = {
  "LCL/ALVI": "Alvinston Branch",
  "LCL/ARKO": "Arkona Branch",
  "LCL/BRIG": "Brigden Branch",
  "LCL/CAML": "Camlachie Branch",
  "LCL/CLWR": "Clearwater Branch",
  "LCL/CORU": "Corunna Branch",
  "LCL/COUR": "Courtright Branch",
  "LCL/FLOR": "Florence Branch",
  "LCL/FORE": "Forest Branch",
  "LCL/GRBE": "Grand Bend Branch",
  "LCL/INWO": "Inwood Branch",
  "LCL/HEAD": "Library Headquarters",
  "LCL/MOOR": "Mooretown Branch",
  "LCL/OILS": "Oil Springs Branch",
  "LCL/PETR": "Petrolia Branch",
  "LCL/PTED": "Point Edward Branch",
  "LCL/PTFR": "Port Franks Branch",
  "LCL/PTLA": "Port Lambton Branch",
  "LCL/SARN": "Sarnia Branch",
  "LCL/SHET": "Shetland Branch",
  "LCL/SOMB": "Sombra Branch",
  "LCL/THED": "Thedford Branch",
  "LCL/WATF": "Watford Branch",
  "LCL/WILK": "Wilkesport Branch",
  "LCL/WYOM": "Wyoming Branch",
  "LCL/LAMR": "Lambton County Archives",
  "LCL/BKMB": "Mobile Library - Program Registration Required",
  "LCL/MAIL": "Library By Mail - Program Registration Required",
};

const named = (codes: string[]) => codes.map((code) => ({ code, name: NAMES[code] ?? code }));

export const BRANCHES = named(
  "ALVI ARKO BRIG CAML CLWR CORU COUR FLOR FORE GRBE INWO HEAD MOOR OILS PETR PTED PTFR PTLA SARN SHET SOMB THED WATF WILK WYOM LAMR"
    .split(" ")
    .map((c) => `LCL/${c}`),
);

const PICKUP_CODES =
  "LCL/ALVI,LCL/ARKO,LCL/BRIG,LCL/CAML,LCL/CLWR,LCL/CORU,LCL/COUR,LCL/FLOR,LCL/FORE,LCL/GRBE,LCL/INWO,LCL/MOOR,LCL/OILS,LCL/PETR,LCL/PTED,LCL/PTFR,LCL/PTLA,LCL/SARN,LCL/SOMB,LCL/THED,LCL/WILK,LCL/WYOM,LCL/BKMB,LCL/MAIL";

export const PICKUP_LOCATIONS = named(PICKUP_CODES.split(","));

export const RESERVE_CONFIG: ReserveConfig = {
  type: "PickupChosenByUser",
  reservationLocations:
    "LCL/ALVI,LCL/ARKO,LCL/BRIG,LCL/CAML,LCL/CLWR,LCL/CORU,LCL/COUR,LCL/FLOR,LCL/FORE,LCL/GRBE,LCL/INWO,LCL/HEAD,LCL/MOOR,LCL/OILS,LCL/PETR,LCL/PTED,LCL/PTFR,LCL/SARN,LCL/PTLA,LCL/SOMB,LCL/THED,LCL/WILK,LCL/WYOM,LCL/BKMB",
  pickupLocations: PICKUP_CODES,
  fields: "HdrPickupLocation",
};

// Borrowing rules from the Circulation Policy (R02.02, rev. Aug 2023). The server enforces
// these; they're here so the model can explain a refusal or plan ahead instead of guessing.
export const LOAN_RULES =
  "Library rules: items can be renewed up to a maximum of three loan periods; an item another patron " +
  "has on hold (isReserved=1) cannot be renewed; items 30 days overdue are treated as lost and a " +
  "replacement fee is invoiced.";

export const HOLD_RULES =
  "Library rules: at most 40 holds on physical items per card at once; a ready hold is kept for pickup for 7 days.";
