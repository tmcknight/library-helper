#!/usr/bin/env node
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { IguanaClient } from "./iguana.ts";
import { registerTools } from "./tools.ts";

const env = process.env;

// One library session shared by every MCP request: it's a single card either way.
const client = new IguanaClient({
  baseUrl: env.LIBRARY_BASE_URL ?? "https://catalogue.lclibrary.ca/iguana/",
  profile: env.LIBRARY_PROFILE ?? "Iguana",
  cardNumber: env.LIBRARY_CARD_NUMBER,
  pin: env.LIBRARY_PIN,
});

function newServer(): McpServer {
  const server = new McpServer({ name: "library-helper", version: "0.1.0" });
  registerTools(server, client);
  return server;
}

if ((env.MCP_TRANSPORT ?? "stdio") === "stdio") {
  await newServer().connect(new StdioServerTransport());
} else {
  await serveHttp();
}

async function serveHttp(): Promise<void> {
  const port = Number(env.PORT ?? 3000);
  const verifyAccess = accessVerifier();

  const http = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    try {
      await verifyAccess(req);
    } catch (e) {
      console.error("rejected request:", e instanceof Error ? e.message : e);
      res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
      return;
    }
    // Stateless: a fresh server/transport per request, no MCP session to track.
    const server = newServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500).end();
    }
  });

  http.listen(port, () => console.error(`library-helper MCP listening on :${port}/mcp`));
}

// Cloudflare Access puts a signed JWT in Cf-Access-Jwt-Assertion on every request it lets
// through. Checking it means the origin can't be reached by going around the tunnel.
function accessVerifier(): (req: IncomingMessage) => Promise<void> {
  const team = env.CF_ACCESS_TEAM_DOMAIN; // e.g. https://yourteam.cloudflareaccess.com
  const aud = env.CF_ACCESS_AUD; // the Access application's Audience (AUD) tag
  if (!team || !aud) {
    if (env.ALLOW_UNAUTHENTICATED !== "1") {
      throw new Error("Set CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD (or ALLOW_UNAUTHENTICATED=1 for local testing).");
    }
    console.error("WARNING: Cloudflare Access JWT check disabled");
    return async () => {};
  }
  const issuer = team.replace(/\/$/, "");
  const jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  const allowed = env.ALLOWED_EMAILS?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return async (req) => {
    const token = req.headers["cf-access-jwt-assertion"];
    if (typeof token !== "string") throw new Error("missing Cf-Access-Jwt-Assertion");
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: aud });
    if (allowed?.length && !allowed.includes(String(payload.email ?? "").toLowerCase())) {
      throw new Error(`email ${payload.email} not in ALLOWED_EMAILS`);
    }
  };
}
