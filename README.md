# library-helper

MCP server for the [Lambton County Library](https://catalogue.lclibrary.ca/iguana/www.main.cls) catalogue and patron account. The site runs Infor Iguana 6.5; this server talks to the same backend endpoints the web UI uses.

## Tools

| Tool | Needs card | What it does |
|---|---|---|
| `search_catalogue` | | Keyword/title/author/subject/series/ISBN search, paged and sortable |
| `get_record` | | Full bibliographic record + per-branch summary |
| `get_availability` | | Every copy: branch, shelfmark, status, due date, hold count |
| `list_branches` | | Branch and pickup location codes |
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

## How the site works

- **Session**: `GET www.main.cls` sets the `CSPSESSIONID-*` cookie and embeds `sessionID` (the `SIDTKN`). `GET www.jsSettings.cls` then exposes the REST token in `Vfocus.Settings.uaUrl` (`Rest.Server.cls?sessionId=…&method=user/`). Idle timeout is 900 s.
- **Every request needs a same-origin `Referer`**. Without it the server returns `200` with an empty body.
- **Catalogue**: `POST Proxy.SearchRequest.cls` (form-encoded, `fu=BibSearch`) returns SRU-style XML. `RequestType=ResultSet_DisplayList` searches, `RecordNumber` + `TemplateId=Iguana_Full` gets a record, `RecordNumber` + `DetailedHoldings=…` gets copies.
- **Account**: `POST Rest.Server.cls?sessionId=<token>&method=user/<action>` with JSON body `{"request": {...}}`. `user/credentials` (card + PIN) returns a patron `sessionId` that every other call passes inside `request`. Actions: `summary`, `loans`, `renewal`, `reservations`, `reserve` (multi-step: `record` → `reserve`), `cancelreservation`, `suspendreservation`, `changereservation`, `paymentsdue`, `loanhistory`, `readinglists`, …
- Lambton-specific settings (branch codes, hold config) are in `src/lambton.ts`. Pointing `LIBRARY_BASE_URL` at another Iguana site needs those changed.

## Remote deployment (claude.ai via Cloudflare Access)

`MCP_TRANSPORT=http` serves stateless Streamable HTTP on `:$PORT/mcp` (`/healthz` for health checks). Every `/mcp` request must carry a valid `Cf-Access-Jwt-Assertion` for `CF_ACCESS_AUD`, so the origin is useless if reached around the tunnel. `ALLOWED_EMAILS` optionally narrows it further.

1. On the server: `cp .env.example .env`, fill it in, `docker compose up -d --build` (attach it to cloudflared's Docker network).
2. Tunnel: add a public hostname, e.g. `library.example.com` → `http://library-helper:3000`.
3. Zero Trust → Access → Applications → add **Self-hosted** app for that hostname, policy = Allow your email. Copy its **AUD tag** into `.env`.
4. Same app → **Advanced settings** → enable **Managed OAuth** (Access becomes the OAuth server, with dynamic client registration). Under allowed redirect URIs add `https://claude.ai/*`.
5. claude.ai → Settings → Connectors → **Add custom connector** → `https://library.example.com/mcp`. Leave client ID/secret blank; Claude registers itself, then you sign in through Access.
