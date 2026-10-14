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

The image defaults to HTTP mode, which refuses to start until an auth mode is configured (see [Remote deployment](#remote-deployment)). For a quick local look, `-e AUTH_MODE=none -p 3000:3000` turns the check off. Never expose that port: anyone who reaches it can use your card.

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

`MCP_TRANSPORT=http` serves stateless Streamable HTTP on `:$PORT/mcp`, with `/healthz` for health checks. Every `/mcp` request has to pass an auth check, because whoever reaches it can use your library card. Pick how with `AUTH_MODE`:

| `AUTH_MODE` | Use when | Works with claude.ai |
|---|---|---|
| [`cloudflare-access`](#cloudflare-access) | The server sits behind a Cloudflare Tunnel | Yes |
| [`jwt`](#jwt) | It sits behind another login proxy that forwards a signed JWT (Pomerium, Google IAP, …) | Yes, if the proxy handles OAuth for MCP clients |
| [`bearer`](#bearer) | Only Claude Code or similar clients connect, e.g. over Tailscale or your LAN | No |
| [`none`](#none) | Trying it out on your own machine | No |

Setup is the same for all of them:

1. `cp .env.example .env`
2. Set `AUTH_MODE` and fill in that mode's section (below). Leave the other sections blank.
3. `docker compose up -d` (pulls the published image; add `--build` to build from source)
4. `docker compose logs` should show `library-helper MCP listening on :3000/mcp (auth: <mode>)`. A missing setting stops the server at startup and names the variable. A rejected request logs why, e.g. `rejected request: missing cf-access-jwt-assertion header`; the client only gets `403`.

`claude.ai` connectors sign in with OAuth and can't send a fixed token, so for claude.ai you need a proxy in front that does the OAuth sign-in, then `cloudflare-access` or `jwt` behind it.

If `AUTH_MODE` is unset it's inferred from the settings present, in this order: `CF_ACCESS_*`, `AUTH_JWKS_URL`, `AUTH_TOKEN`, `ALLOW_UNAUTHENTICATED=1`. With none of them the server refuses to start.

### cloudflare-access

Cloudflare Access signs every request it lets through with a JWT in `Cf-Access-Jwt-Assertion`. The server checks it, so it's useless if reached around the tunnel.

1. Run the container on the same Docker network as `cloudflared` (edit `networks` in `compose.yaml`). No ports need publishing.
2. Tunnel: add a public hostname, e.g. `library.example.com` → `http://library-helper:3000`.
3. Zero Trust → Access → Applications → add a **Self-hosted** app for that hostname, with a policy that allows your email.
4. In `.env`, set `CF_ACCESS_TEAM_DOMAIN` (Zero Trust → Settings → Custom pages, e.g. `https://yourteam.cloudflareaccess.com`) and `CF_ACCESS_AUD` (the app's **AUD tag**, on its Overview tab). Optionally set `ALLOWED_EMAILS` too.
5. Same app → **Advanced settings** → enable **Managed OAuth**, so Access becomes the OAuth server with dynamic client registration. Under allowed redirect URIs add `https://claude.ai/*`.
6. claude.ai → Settings → Connectors → **Add custom connector** → `https://library.example.com/mcp`. Leave client ID/secret blank; Claude registers itself, then you sign in through Access.

### jwt

For any other proxy that logs people in and forwards a signed JWT to the app. The server fetches the proxy's public keys from `AUTH_JWKS_URL` and checks each token's signature, expiry, audience and (if set) issuer.

| Setting | What to put |
|---|---|
| `AUTH_JWKS_URL` | The proxy's JWKS endpoint |
| `AUTH_AUDIENCE` | The token's expected `aud` claim. Required: without it any token from the proxy would pass |
| `AUTH_ISSUER` | The token's expected `iss` claim. Optional but recommended |
| `AUTH_JWT_HEADER` | The header carrying the token. Default `Authorization` (a `Bearer ` prefix is stripped) |
| `ALLOWED_EMAILS` | Optional: only tokens whose `email` claim is in this comma-separated list |

Pomerium (route `library.example.com`):

```sh
AUTH_MODE=jwt
AUTH_JWKS_URL=https://library.example.com/.well-known/pomerium/jwks.json
AUTH_AUDIENCE=library.example.com
AUTH_ISSUER=library.example.com
AUTH_JWT_HEADER=X-Pomerium-Jwt-Assertion
```

Google Cloud IAP:

```sh
AUTH_MODE=jwt
AUTH_JWKS_URL=https://www.gstatic.com/iap/verify/public_key-jwk
AUTH_AUDIENCE=/projects/<project-number>/global/backendServices/<service-id>
AUTH_ISSUER=https://cloud.google.com/iap
AUTH_JWT_HEADER=X-Goog-IAP-JWT-Assertion
```

For other proxies (Authentik, oauth2-proxy, …), look up which header carries the JWT and where its JWKS is served. To find the right `aud` and `iss`, decode a token the proxy forwards: its middle part is base64url-encoded JSON.

### bearer

A shared secret in `Authorization: Bearer <token>`, for clients that let you set headers. Best kept off the public internet, e.g. reachable only over Tailscale or your LAN.

1. Generate a token: `openssl rand -hex 32`, and set it as `AUTH_TOKEN` in `.env`.
2. Publish the port: add `ports: ["3000:3000"]` to `compose.yaml`.
3. Add it to Claude Code:

   ```sh
   claude mcp add --transport http library-helper http://<host>:3000/mcp \
     --header "Authorization: Bearer <token>"
   ```

Over plain HTTP the token travels unencrypted. Use HTTPS in front if the network isn't one you trust.

### none

No check at all: `AUTH_MODE=none` (or `ALLOW_UNAUTHENTICATED=1`). Only for local testing, e.g. with the MCP Inspector against `http://localhost:3000/mcp`. Never expose the port: anyone who reaches it can renew, place and cancel holds on your card.

## Releasing

Bump `version` in `package.json`, merge, then tag `main`:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The `docker` workflow builds both architectures and pushes the image to GHCR. On mcbuntu, redeploy the Portainer stack with "Re-pull image" on.
