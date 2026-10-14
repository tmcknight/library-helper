# library-helper

MCP server for the [Lambton County Library](https://catalogue.lclibrary.ca/iguana/www.main.cls) catalogue and patron account. The site runs Infor Iguana 6.5; this server talks to the same backend endpoints the web UI uses.

> [!NOTE]
> Unofficial. Not affiliated with or endorsed by Lambton County Library or Infor. The endpoints are undocumented and may change without notice. Use your own card, keep request volume reasonable, and follow the library's terms of use.

## Tools

| Tool | Needs card | What it does |
|---|---|---|
| `search_catalogue` | | Keyword/title/author/subject/series/ISBN search, paged and sortable |
| `get_record` | | Full bibliographic record + per-branch summary |
| `get_availability` | | Every copy: branch, shelfmark, status, due date, hold count |
| `list_branches` | | Branch and pickup location codes |
| `branch_hours` | | Weekly opening hours per branch, plus temporary closures |
| `account_summary` | ✓ | Loan/hold/overdue counts |
| `list_loans` / `renew_loans` | ✓ | Checked-out items; renew by barcode |
| `list_holds` / `place_hold` / `cancel_holds` | ✓ | Reservations |
| `list_fines` | ✓ | Outstanding fees (cents) |
| `loan_history` | ✓ | Past loans, if enabled on the account |

## Setup

Requires Node ≥ 23.6 (runs the TypeScript source directly).

```sh
npm install
npm test
```

Claude Code:

```sh
claude mcp add library-helper \
  -e LIBRARY_CARD_NUMBER=<card> -e LIBRARY_PIN=<pin> \
  -- node /absolute/path/to/library-helper/src/index.ts
```

Omit the env vars for catalogue-only use.

### Docker

Images for `linux/amd64` and `linux/arm64` are published to `ghcr.io/tmcknight/library-helper` from each `v*` tag (`latest`, `X.Y.Z`, `X.Y`); `edge` tracks `main`. No local Node needed:

```sh
claude mcp add library-helper -- docker run -i --rm \
  -e MCP_TRANSPORT=stdio -e LIBRARY_CARD_NUMBER=<card> -e LIBRARY_PIN=<pin> \
  ghcr.io/tmcknight/library-helper
```

The image defaults to HTTP mode (see [Remote deployment](#remote-deployment-claudeai-via-cloudflare-access)), which refuses to start without Cloudflare Access settings. For a quick local look, `-e ALLOW_UNAUTHENTICATED=1 -p 3000:3000` turns the check off. Never expose that port: anyone who reaches it can use your card.

To poke at the tools without Claude, use the MCP Inspector:

```sh
npx @modelcontextprotocol/inspector node src/index.ts
```

## Usage

Ask in plain language; Claude picks the tools.

- "Does the library have *Project Hail Mary*? Which branches have a copy in right now?"
- "Find the newest books by Louise Penny."
- "Put a hold on the large print edition for pickup at Petrolia."
- "What do I have checked out, and when is it due? Renew anything due this week."
- "Do I have any holds ready for pickup?"
- "Do I owe any fines?"
- "Is the Forest branch open right now?"

### A typical flow

1. **Search.** `search_catalogue` with `{"query": "project hail mary", "index": "title"}`. A popular title usually comes back as a `cluster` with one entry per format (trimmed):

   ```json
   {
     "recordId": "1.56450",
     "kind": "cluster",
     "title": "Project Hail Mary",
     "versions": [
       { "label": "eBook",       "records": [{ "recordId": "1.785848", "reservable": false }] },
       { "label": "Fiction",     "records": [{ "recordId": "1.693721", "reservable": true }] },
       { "label": "Large print", "records": [{ "recordId": "1.710522", "reservable": true }] }
     ]
   }
   ```

2. **Pick a format.** Use a record id from `versions`, never the cluster id. eBooks have no physical copies.
3. **Check copies.** `get_availability` with `{"recordId": "1.710522"}` lists every copy with branch, shelfmark, status and due date.
4. **Place a hold.** `place_hold` with `{"recordId": "1.710522", "pickupLocation": "LCL/PETR"}`. `list_branches` gives the valid pickup codes.

Other searches: set `index` to `author`, `subject`, `series` or `isbn`, `sort` to `newest`, and page with `start` / `limit`.

## How the site works

- **Session**: `GET www.main.cls` sets the `CSPSESSIONID-*` cookie and embeds `sessionID` (the `SIDTKN`). `GET www.jsSettings.cls` then exposes the REST token in `Vfocus.Settings.uaUrl` (`Rest.Server.cls?sessionId=…&method=user/`). Idle timeout is 900 s.
- **Every request needs a same-origin `Referer`**. Without it the server returns `200` with an empty body.
- **Catalogue**: `POST Proxy.SearchRequest.cls` (form-encoded, `fu=BibSearch`) returns SRU-style XML. `RequestType=ResultSet_DisplayList` searches, `RecordNumber` + `TemplateId=Iguana_Full` gets a record, `RecordNumber` + `DetailedHoldings=…` gets copies.
- **Account**: `POST Rest.Server.cls?sessionId=<token>&method=user/<action>` with JSON body `{"request": {...}}`. `user/credentials` (card + PIN) returns a patron `sessionId` that every other call passes inside `request`. Actions: `summary`, `loans`, `renewal`, `reservations`, `reserve` (multi-step: `record` → `reserve`), `cancelreservation`, `suspendreservation`, `changereservation`, `paymentsdue`, `loanhistory`, `readinglists`, …
- **Hours** aren't in Iguana. `branch_hours` reads the table on the library website's [hours page](https://www.lclibrary.ca/en/borrow/lambton-county-library-hours.aspx) (cached for an hour).
- Lambton-specific settings (branch codes, hold config) are in `src/lambton.ts`. Pointing `LIBRARY_BASE_URL` at another Iguana site needs those changed.

## Remote deployment

`MCP_TRANSPORT=http` serves stateless Streamable HTTP on `:$PORT/mcp` (`/healthz` for health checks). Every `/mcp` request goes through one auth check, picked with `AUTH_MODE`. Without it the mode is inferred from whichever settings are present, and the server refuses to start if there are none.

| `AUTH_MODE` | Settings | Checks |
|---|---|---|
| `cloudflare-access` | `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` | The `Cf-Access-Jwt-Assertion` JWT that [Cloudflare Access](#claudeai-via-cloudflare-access) adds |
| `jwt` | `AUTH_JWKS_URL`, `AUTH_AUDIENCE`, optional `AUTH_ISSUER`, `AUTH_JWT_HEADER` (default `Authorization`) | A JWT from any identity-aware proxy (Pomerium, oauth2-proxy, Authentik, Google IAP, …), verified against its JWKS |
| `bearer` | `AUTH_TOKEN` | `Authorization: Bearer <AUTH_TOKEN>` |
| `none` | | Nothing. Local testing only (`ALLOW_UNAUTHENTICATED=1` also works) |

`ALLOWED_EMAILS` (comma-separated) further restricts both JWT modes to tokens with a matching `email` claim.

claude.ai connectors sign in with OAuth and can't send a fixed token, so `bearer` is for Claude Code and similar clients (`claude mcp add --transport http library-helper https://host/mcp --header "Authorization: Bearer <token>"`). For claude.ai, put a proxy that handles the OAuth sign-in in front and use one of the JWT modes.

### claude.ai via Cloudflare Access

The origin only accepts requests carrying a valid Access JWT for `CF_ACCESS_AUD`, so it's useless if reached around the tunnel.

1. On the server: `cp .env.example .env`, fill it in, `docker compose up -d` (pulls the published image; `--build` builds from source). Attach it to cloudflared's Docker network.
2. Tunnel: add a public hostname, e.g. `library.example.com` → `http://library-helper:3000`.
3. Zero Trust → Access → Applications → add **Self-hosted** app for that hostname, policy = Allow your email. Copy its **AUD tag** into `.env`.
4. Same app → **Advanced settings** → enable **Managed OAuth** (Access becomes the OAuth server, with dynamic client registration). Under allowed redirect URIs add `https://claude.ai/*`.
5. claude.ai → Settings → Connectors → **Add custom connector** → `https://library.example.com/mcp`. Leave client ID/secret blank; Claude registers itself, then you sign in through Access.

## Releasing

Bump `version` in `package.json`, merge, then tag `main`:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The `docker` workflow builds both architectures and pushes the image to GHCR. On mcbuntu, redeploy the Portainer stack with "Re-pull image" on.
