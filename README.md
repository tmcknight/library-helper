# library-helper

MCP server for the [Lambton County Library](https://lcl.ca.iiivega.com/portal) catalogue and patron account. Since October 2026 the library runs Innovative's Vega Discover on top of Sierra; this server talks to the same JSON API the portal uses.

> [!NOTE]
> Unofficial. Not affiliated with or endorsed by Lambton County Library or Innovative (Clarivate). The endpoints are undocumented and may change without notice. Use your own card, keep request volume reasonable, and follow the library's terms of use.

## Tools

| Tool | Needs card | What it does |
|---|---|---|
| `search_catalogue` | | Keyword (incl. ISBN/UPC)/title/author/subject/series/call-number search, paged and sortable |
| `get_record` | | Full bibliographic record, per-branch summary, other formats |
| `get_availability` | | Every copy: branch, call number, status, due date |
| `list_branches` | | Branch and pickup location codes |
| `branch_hours` | | Weekly opening hours, address and phone per branch, plus temporary closures |
| `account_summary` | ✓ | Loan/hold/overdue counts, money owed, card expiry |
| `list_loans` / `renew_loans` | ✓ | Checked-out items (incl. Libby loans); renew by checkout id |
| `list_holds` / `place_hold` / `cancel_holds` | ✓ | Holds |
| `list_fines` | ✓ | Outstanding fees (dollars) |
| `loan_history` | ✓ | Past loans, if reading history is turned on for the card |

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

1. **Search.** `search_catalogue` with `{"query": "project hail mary", "index": "title"}`. Each hit is one work, with its formats and each format's editions (trimmed):

   ```json
   {
     "title": "Project Hail Mary : a novel",
     "author": "Weir, Andy.",
     "formats": [
       { "format": "Book",        "status": "Available", "editions": [{ "recordId": "57455" }],
         "branches": [{ "code": "8", "name": "Clearwater Library", "available": true }] },
       { "format": "Large Print", "status": "Available", "editions": [{ "recordId": "62392" }] },
       { "format": "Ebook", "electronic": true, "note": "Libby/OverDrive title: borrow or hold it in the Libby app", "editions": [] }
     ]
   }
   ```

2. **Pick a format.** Use an edition's `recordId`. Electronic formats are Libby titles and can't be held here.
3. **Check copies.** `get_availability` with `{"recordId": "62392"}` lists every copy with branch, call number, status and due date.
4. **Place a hold.** `place_hold` with `{"recordId": "62392", "pickupLocation": "19"}`. `list_branches` gives the pickup codes; the server also checks the code against the record's own pickup list.

Other searches: set `index` to `author`, `subject`, `series` or `call_number`, `sort` to `newest`, and page with `page` / `limit`.

## Web UI

In HTTP mode the server also serves a web app at `/`: catalogue search with per-format availability, record pages with every copy and a "Place hold" button, your loans (renew one or several), holds (cancel), fines and reading history, and every branch's hours with an open-now indicator. It follows the system light/dark setting and works on a phone.

```sh
MCP_TRANSPORT=http AUTH_MODE=none LIBRARY_CARD_NUMBER=<card> LIBRARY_PIN=<pin> node src/index.ts
# open http://localhost:3000/
```

- The page itself holds no data and is served to anyone; everything it shows comes from `/api/*`, which passes the same `AUTH_MODE` check as `/mcp`. Behind Cloudflare Access or another login proxy, protect the whole hostname and the browser's session covers both. With `bearer`, the page asks for the token once and keeps it in that browser's local storage.
- `/api` only accepts JSON `POST`s, so another site can't submit a form that renews or cancels on your card through your login cookie.
- Covers come from Open Library by ISBN when it has one; otherwise the page draws a plain title card.
- Set `WEB_UI=0` to turn it off and serve only `/mcp`.

The UI is plain HTML, CSS and JavaScript in `web/`, with no build step. `src/web.ts` holds its JSON API.

## How the site works

- **API**: JSON under `https://ca.iiivega.com/api/…`. Every request carries `iii-customer-domain: lcl.ca.iiivega.com`, `iii-host-domain` (same value) and an `api-version` header (`1`, or `2` for search and the patron profile). Errors come back as `{status, type, message, error: [{message, target}]}`.
- **Catalogue** (anonymous): `POST api/search-result/search/format-groups` searches (`searchText`, `searchType` = `everything|title|agent|concept|series|callNumber`, `sorting` = `relevance|publicationDate|title|author`). Results are *format groups* (works) with *material tabs* (formats) whose *editions* carry a Sierra bib number (`recordId`) and an instance UUID. `GET …/format-groups?recordId=` finds the group for a bib number, `GET …/instances/{uuid}` is the full record and `…/instances/{uuid}/items` the copies.
- **Login**: Keycloak at `auth.ca.iiivega.com`, realm `lcl`, public client `convergence`. The server runs the authorization-code flow itself: `GET …/auth` gives a plain username/PIN form, posting it redirects to the portal with a `code`, and `POST …/token` exchanges it. Access tokens last 10 minutes and are refreshed with the 90-day refresh token.
- **Account** (Bearer token): `GET api/search-result/patrons/me` (profile, `api-version: 2`, needs `listsPrefetch`), `…/patrons/me/checkouts`, `POST …/checkouts/{id}/renew`, `…/patrons/me/holds`, `POST api/search-result/gates/request-form` (pickup locations for a record), `POST …/gates/holds` (place), `DELETE …/gates/holds/{id}` (cancel), `GET …/gates/patrons/me/fines`, and `api/search-result/bookshelf/reading-history`. Ids: the patron id is the card number; holds use Sierra bib numbers with `recordType: "b"`.
- **Hours** aren't in Vega. `branch_hours` reads the library website's [locations and hours page](https://www.lclibrary.ca/visit/locations-and-hours/) (cached for an hour).
- Lambton-specific settings (portal domain, Keycloak realm, branch codes) are in `src/lambton.ts`; another Vega library would need those changed.

## Remote deployment

`MCP_TRANSPORT=http` serves stateless Streamable HTTP on `:$PORT/mcp`, the [web UI](#web-ui) on `/`, and `/healthz` for health checks. Every `/mcp` and `/api` request has to pass an auth check, because whoever reaches it can use your library card. Pick how with `AUTH_MODE`:

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
