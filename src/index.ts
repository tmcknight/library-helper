#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { authFromEnv } from "./auth.ts";
import { VegaClient } from "./vega.ts";
import { registerTools } from "./tools.ts";
import { serveApi, serveStatic } from "./web.ts";
import type { WebApi } from "./web.ts";
import { Sessions } from "./sessions.ts";

const env = process.env;

// One library session shared by every MCP request: it's a single card either way. The web
// UI doesn't use it; people sign in there with their own card.
const client = new VegaClient({
  cardNumber: env.LIBRARY_CARD_NUMBER,
  pin: env.LIBRARY_PIN,
});

function newServer(): McpServer {
  const server = new McpServer({ name: "library-helper", version: "0.3.0" });
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
  const auth = authFromEnv(env);
  const webUi = env.WEB_UI !== "0";
  const web: WebApi = {
    anonymous: new VegaClient({ noCredentialsMessage: "Sign in with your library card to see your account." }),
    sessions: new Sessions((cardNumber, pin) => new VegaClient({ cardNumber, pin })),
  };

  const http = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (path === "/healthz") {
      res.writeHead(200).end("ok");
      return;
    }
    // Web UI: the page itself is public (no data in it); its /api calls are checked below.
    if (req.method === "GET" && webUi && (await serveStatic(path, res))) return;
    const isApi = webUi && (path === "/api" || path.startsWith("/api/"));
    if (path !== "/mcp" && !isApi) {
      res.writeHead(404).end();
      return;
    }
    try {
      await auth.verify(req);
    } catch (e) {
      console.error("rejected request:", e instanceof Error ? e.message : e);
      res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden");
      return;
    }
    if (isApi) {
      await serveApi(web, req, res);
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

  http.listen(port, () => {
    console.error(`library-helper MCP listening on :${port}/mcp (auth: ${auth.mode})`);
    if (webUi) console.error(`web UI on :${port}/`);
  });
}
