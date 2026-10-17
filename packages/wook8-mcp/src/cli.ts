// wook8-mcp — use a Urumi MCP gateway from any MCP client, or run the WooCommerce
// MCP server on its own. stdout is the MCP channel, so everything human goes to stderr.
import { parseArgs } from "node:util";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Server } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { endpointOf } from "./endpoint.ts";

const VERSION = "0.1.0";
const say = (text: string) => process.stderr.write(`${text}\n`);


const HELP = `wook8-mcp ${VERSION}

Usage:
  wook8-mcp connect --url <gateway> --key <ugw_...>   stdio bridge to a Urumi gateway, for any MCP client
  wook8-mcp woo                                       WooCommerce MCP server over stdio, for your own store
  wook8-mcp config --url <gateway> --key <ugw_...>    print ready-to-paste client configuration

Environment (instead of flags):
  URUMI_GATEWAY_URL, URUMI_API_KEY                    for connect and config
  WOO_URL, WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET      for woo (a WooCommerce REST key, read/write)
  STORE_TIMEZONE                                      for woo: what "today" means (default UTC)
`;

async function connect(url: string, key: string): Promise<void> {
  const client = new Client({ name: "wook8-mcp-bridge", version: VERSION });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(endpointOf(url)), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }),
    );
  } catch (err) {
    say(`wook8-mcp: could not reach ${endpointOf(url)}: ${(err as Error).message}`);
    process.exit(1);
  }
  // Each stdio request is answered by the gateway, so its permissions, timeouts and audit log all still apply.
  serveStdio(() => {
    const server = new Server({ name: "urumi-gateway", version: VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler("tools/list", () => client.listTools(undefined, { cacheMode: "bypass" }));
    server.setRequestHandler("tools/call", (request) =>
      client.callTool({ name: request.params.name, arguments: request.params.arguments }),
    );
    return server;
  });
}

async function woo(): Promise<void> {
  for (const name of ["WOO_URL", "WOO_CONSUMER_KEY", "WOO_CONSUMER_SECRET"]) {
    if (!process.env[name]) {
      say(`wook8-mcp woo: set ${name} (see wook8-mcp --help)`);
      process.exit(1);
    }
  }
  // Loaded only here: the store client reads its settings when it is imported.
  const { buildServer } = await import("../../../apps/woo-mcp/src/tools.ts");
  serveStdio(buildServer);
}

function config(url: string, key: string): void {
  const endpoint = endpointOf(url);
  say(`# Claude Code (native HTTP)
claude mcp add --transport http urumi ${endpoint} --header "Authorization: Bearer ${key}"

# Cursor / Claude Desktop / any client with an mcp.json
{ "mcpServers": { "urumi": { "command": "npx", "args": ["-y", "wook8-mcp", "connect"],
    "env": { "URUMI_GATEWAY_URL": "${url}", "URUMI_API_KEY": "${key}" } } } }

# Codex (~/.codex/config.toml)
[mcp_servers.urumi]
command = "npx"
args = ["-y", "wook8-mcp", "connect"]
env = { URUMI_GATEWAY_URL = "${url}", URUMI_API_KEY = "${key}" }`);
}

{
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { url: { type: "string" }, key: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
  });
  const command = values.help ? "help" : values.version ? "version" : (positionals[0] ?? "help");
  const url = values.url ?? process.env.URUMI_GATEWAY_URL;
  const key = values.key ?? process.env.URUMI_API_KEY;
  if (command === "connect" || command === "config") {
    if (!url || !key) {
      say(`wook8-mcp ${command}: needs --url and --key (or URUMI_GATEWAY_URL and URUMI_API_KEY)`);
      process.exit(1);
    }
    command === "connect" ? await connect(url, key) : config(url, key);
  } else if (command === "woo") await woo();
  else if (command === "version") say(VERSION);
  else say(HELP);
}
