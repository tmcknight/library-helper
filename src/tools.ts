import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { VegaError, SEARCH_TYPES, LIST_SORTS } from "./vega.ts";
import type { VegaClient } from "./vega.ts";
import { fetchBranchHours, libraryToday } from "./hours.ts";
import { BRANCHES, HOLD_RULES, HOURS_URL, LOAN_RULES, PICKUP_LOCATIONS } from "./lambton.ts";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const value = await fn();
    return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
  } catch (e) {
    const msg = e instanceof VegaError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

export function registerTools(server: McpServer, client: VegaClient): void {
  const recordId = z
    .string()
    .regex(/^\d+$/)
    .describe('Catalogue record id (Sierra bib number) from an edition in search_catalogue, e.g. "57455"');

  // ---- Catalogue ----------------------------------------------------------------

  server.registerTool(
    "search_catalogue",
    {
      title: "Search catalogue",
      description:
        "Search the Lambton County Library catalogue. Each hit is one work; its formats (Book, Large Print, DVD, " +
        "Kit, ...) each list editions with a recordId, plus which branches hold that format and whether a copy is " +
        "available there. Use an edition's recordId with get_record, get_availability and place_hold. " +
        "Formats marked electronic are Libby/OverDrive titles: they can't be used with these tools; point the user to Libby.",
      inputSchema: {
        query: z.string().min(1),
        index: z
          .enum(Object.keys(SEARCH_TYPES) as [keyof typeof SEARCH_TYPES])
          .default("keyword")
          .describe("keyword also matches ISBN and UPC"),
        limit: z.number().int().min(1).max(50).default(10),
        page: z.number().int().min(1).default(1).describe("1-based page number"),
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
      description:
        "Full bibliographic details for one catalogue record (summary, contributors, subjects, ISBN), a per-branch " +
        "availability summary, and the recordIds of the work's other formats and editions.",
      inputSchema: { recordId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ recordId }) => run(() => client.getRecord(recordId)),
  );

  server.registerTool(
    "get_availability",
    {
      title: "Get item availability",
      description:
        "Every physical copy of a record: branch, call number, status (In, Out, Held, Shipped = in transit between " +
        "branches, ...), available flag and due date for copies on loan.",
      inputSchema: { recordId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ recordId }) => run(() => client.getAvailability(recordId)),
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

  server.registerTool(
    "branch_hours",
    {
      title: "Branch hours",
      description:
        "Regular weekly opening hours, address and phone for each branch, from the library website. hours maps each weekday to an " +
        'opening range like "10AM - 3PM", or null when closed that day. A note such as "Temporarily closed" ' +
        "overrides the listed hours. today is the current date, weekday and time in the library's timezone. " +
        "Statutory-holiday closures aren't listed; point the user to the branch url to confirm.",
      inputSchema: {
        branch: z
          .string()
          .min(1)
          .optional()
          .describe('Branch name or location code, e.g. "Petrolia" or "19". Omit for all branches.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ branch }) =>
      run(async () => {
        let branches = await fetchBranchHours();
        if (branch) {
          const q = branch.trim().toLowerCase();
          branches = branches.filter((b) => b.code?.toLowerCase() === q || b.name.toLowerCase().includes(q));
          if (!branches.length) throw new Error(`no branch matching "${branch}"; omit branch to list all`);
        }
        return { today: libraryToday(), source: HOURS_URL, branches };
      }),
  );

  // ---- Patron account (needs LIBRARY_CARD_NUMBER / LIBRARY_PIN) -------------------

  server.registerTool(
    "account_summary",
    {
      title: "Account summary",
      description:
        "Counts of loans, overdue items, holds and holds ready for pickup on the configured library card, plus " +
        "money owed (dollars), card expiry date and home library.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => client.summary()),
  );

  server.registerTool(
    "list_loans",
    {
      title: "List current loans",
      description:
        "Items currently checked out on the library card, soonest due first. dueDate is an ISO timestamp in UTC " +
        "(end of the due day in Ontario). renewals is how many times it has been renewed; canRenew=false means " +
        "it can't be renewed right now (limit reached or another patron has it on hold). source=overdrive marks " +
        "Libby e-content, which returns itself and is renewed in the Libby app, not with renew_loans. " +
        LOAN_RULES,
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.loans(limit)),
  );

  server.registerTool(
    "renew_loans",
    {
      title: "Renew loans",
      description:
        "Renew checked-out items by checkoutId (from list_loans). Returns per-item success with the new due date, " +
        "or the refusal reason. " +
        LOAN_RULES,
      inputSchema: { checkoutIds: z.array(z.string().min(1)).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ checkoutIds }) => run(() => client.renew(checkoutIds)),
  );

  server.registerTool(
    "list_holds",
    {
      title: "List holds",
      description:
        "Holds on the library card: status (waiting, in transit, ready for pickup, ...), queue position, pickup " +
        "branch and expiry. " +
        HOLD_RULES,
      inputSchema: { limit: z.number().int().min(1).max(200).default(100) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.holds(limit)),
  );

  server.registerTool(
    "place_hold",
    {
      title: "Place hold",
      description:
        "Place a hold on a catalogue record (an edition's recordId) for pickup at a branch. " +
        "pickupLocation is a branch code from list_branches' pickupLocations; the server checks it against the " +
        "record's own pickup list and names the valid ones if it doesn't fit. " +
        HOLD_RULES,
      inputSchema: {
        recordId,
        pickupLocation: z.string().regex(/^\d+$/).describe('Branch code, e.g. "19" for Petrolia'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ recordId, pickupLocation }) => run(() => client.placeHold(recordId, pickupLocation)),
  );

  server.registerTool(
    "cancel_holds",
    {
      title: "Cancel holds",
      description: "Cancel holds by holdId (from list_holds). Loses the queue position; cannot be undone.",
      inputSchema: { holdIds: z.array(z.string().min(1)).min(1) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ holdIds }) => run(() => client.cancelHolds(holdIds)),
  );

  server.registerTool(
    "list_fines",
    {
      title: "List fines and fees",
      description: "Outstanding fines and fees on the library card. Amounts are in dollars.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    () => run(() => client.fines()),
  );

  server.registerTool(
    "loan_history",
    {
      title: "Loan history",
      description:
        "Previously borrowed items, newest first. Only available if reading history is turned on for the card; " +
        "otherwise returns enabled=false.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(50) },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ limit }) => run(() => client.loanHistory(limit)),
  );

  // ---- Reading lists --------------------------------------------------------------

  const listId = z.string().uuid().describe("listId from list_reading_lists");

  server.registerTool(
    "list_reading_lists",
    {
      title: "Reading lists",
      description:
        "The patron's saved reading lists. Without listId: each list's listId, name and item count (every card has a " +
        '"For Later" list, plus any the patron made). With listId: that list\'s titles, each like a search_catalogue hit ' +
        "(formats, branch availability) with the recordId of the saved edition.",
      inputSchema: {
        listId: listId.optional(),
        sort: z.enum(LIST_SORTS).default("date.desc").describe("date = when it was added to the list"),
        limit: z.number().int().min(1).max(200).default(50),
        page: z.number().int().min(1).default(1),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    ({ listId, sort, limit, page }) => run(() => (listId ? client.listItems(listId, { sort, limit, page }) : client.lists())),
  );

  // The list to use when the caller doesn't name one: the patron's first own list, else For Later.
  async function defaultList() {
    const lists = await client.lists();
    const l = lists.find((x) => x.type === "regular") ?? lists[0];
    if (!l) throw new VegaError("NoLists", "this card has no reading lists");
    return l;
  }

  server.registerTool(
    "add_to_list",
    {
      title: "Add to reading list",
      description:
        "Save a catalogue record to one of the patron's reading lists. Without listId it goes on their first own list " +
        "(or For Later if they have none). Adding a title that's already on the list is harmless.",
      inputSchema: { recordId, listId: listId.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ recordId, listId }) =>
      run(async () => {
        const target = listId ?? (await defaultList()).listId;
        return client.updateListItem({ recordId }, [target], []);
      }),
  );

  server.registerTool(
    "remove_from_list",
    {
      title: "Remove from reading list",
      description: "Take a title off one reading list, or off every list it's on when listId is omitted.",
      inputSchema: { recordId, listId: listId.optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    ({ recordId, listId }) =>
      run(async () => {
        const { formatGroupId } = await client.getRecord(recordId);
        const from = listId ? [listId] : (await client.listsContaining(formatGroupId)).containing;
        if (!from.length) return { removedFrom: [], note: "that title isn't on any of your lists" };
        return client.updateListItem({ formatGroupId, recordId }, [], from);
      }),
  );
}
