import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { IguanaError, SEARCH_INDEXES } from "./iguana.ts";
import type { IguanaClient } from "./iguana.ts";
import { BRANCHES, PICKUP_LOCATIONS, RESERVE_CONFIG } from "./lambton.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    const msg = e instanceof IguanaError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export function registerTools(server: McpServer, client: IguanaClient): void {
  const recordId = z.string().regex(/^\d+\.\d+$/).describe('Catalogue record id, e.g. "1.750133"');

  // ---- Catalogue ----------------------------------------------------------------

  server.registerTool(
    "search_catalogue",
    {
      title: "Search catalogue",
      description:
        "Search the Lambton County Library catalogue. Results are either single records (kind=record) or " +
        "clusters grouping several formats of one work (kind=cluster). A cluster's versions (Fiction, Large print, " +
        "eBook, ...) each list their own records; use those record ids with get_record, get_availability and place_hold, " +
        "never the cluster id. eBook/eAudiobook records have no physical copies.",
      inputSchema: {
        query: z.string().min(1),
        index: z.enum(Object.keys(SEARCH_INDEXES) as [keyof typeof SEARCH_INDEXES]).default("keyword"),
        limit: z.number().int().min(1).max(50).default(10),
        start: z.number().int().min(1).default(1).describe("1-based offset for paging"),
        sort: z.enum(["relevance", "newest", "title", "author"]).default("relevance"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    (args) => run(() => client.search(args)),
  );

  server.registerTool(
    "get_record",
    {
      title: "Get record details",
      description: "Full bibliographic details for one catalogue record, plus a per-branch availability summary.",
      inputSchema: { recordId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ recordId }) => run(() => client.getRecord(recordId)),
  );

  server.registerTool(
    "get_availability",
    {
      title: "Get item availability",
      description: "Every physical copy of a record: branch, shelfmark, status (inthelibrary, onloan, ...) and hold count.",
      inputSchema: { recordId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ recordId }) => run(() => client.getHoldings(recordId)),
  );

  server.registerTool(
    "list_branches",
    {
      title: "List branches",
      description: "Library branches and their location codes. pickupLocations are valid for place_hold.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () => run(async () => ({ branches: BRANCHES, pickupLocations: PICKUP_LOCATIONS })),
  );

  // ---- Patron account (needs LIBRARY_CARD_NUMBER / LIBRARY_PIN) -------------------

  server.registerTool(
    "account_summary",
    {
      title: "Account summary",
      description: "Counts of loans, overdue items, holds and holds ready for pickup on the configured library card.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => client.summary()),
  );

  server.registerTool(
    "list_loans",
    {
      title: "List current loans",
      description: "Items currently checked out on the library card, with due dates and renewal info.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.loans(1, limit)),
  );

  server.registerTool(
    "renew_loans",
    {
      title: "Renew loans",
      description: "Renew checked-out items by barcode (from list_loans). Returns per-item success or refusal reason.",
      inputSchema: { barcodes: z.array(z.string().min(1)).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ barcodes }) => run(() => client.renew(barcodes)),
  );

  server.registerTool(
    "list_holds",
    {
      title: "List holds",
      description: "Holds (reservations) on the library card: queue position, pickup branch, ready-for-pickup status.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.holds(1, limit)),
  );

  server.registerTool(
    "place_hold",
    {
      title: "Place hold",
      description:
        "Place a hold on a catalogue record (not a cluster id) for pickup at a branch. " +
        "Use list_branches for valid pickupLocation codes.",
      inputSchema: {
        recordId,
        pickupLocation: z.enum(PICKUP_LOCATIONS.map((p) => p.code) as [string, ...string[]]),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ recordId, pickupLocation }) => run(() => client.placeHold(recordId, pickupLocation, RESERVE_CONFIG)),
  );

  server.registerTool(
    "cancel_holds",
    {
      title: "Cancel holds",
      description: "Cancel holds by reservation number (from list_holds). Loses the queue position; cannot be undone.",
      inputSchema: { reservationNumbers: z.array(z.string().min(1)).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ reservationNumbers }) => run(() => client.cancelHolds(reservationNumbers)),
  );

  server.registerTool(
    "list_fines",
    {
      title: "List fines and fees",
      description: "Outstanding fines and fees on the library card. Amounts are in cents.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => client.fines()),
  );

  server.registerTool(
    "loan_history",
    {
      title: "Loan history",
      description: "Previously borrowed items (only if loan history is enabled on the account).",
      inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.loanHistory(1, limit)),
  );
}
