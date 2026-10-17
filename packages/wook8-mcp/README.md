# wook8-mcp

Use a [Urumi MCP gateway](https://github.com/kazuma761/urumi-mcp) from any MCP client,
or run the WooCommerce MCP server against your own store. No install step: `npx`.

```bash
npx -y wook8-mcp connect --url https://app.example.com --key ugw_...   # stdio bridge to a gateway
npx -y wook8-mcp woo                                                   # WooCommerce MCP over stdio
npx -y wook8-mcp config  --url https://app.example.com --key ugw_...   # print client config snippets
```

## `connect`: one gateway, every tool

Speaks MCP over stdio and forwards each request to your team's gateway, so clients that
only start local processes (Codex, older Claude Desktop builds, editors) get every tool
the gateway exposes. The gateway's permissions, timeouts and audit log still apply.

Codex, `~/.codex/config.toml`:

```toml
[mcp_servers.urumi]
command = "npx"
args = ["-y", "wook8-mcp", "connect"]
env = { URUMI_GATEWAY_URL = "https://app.example.com", URUMI_API_KEY = "ugw_..." }
```

Any `mcp.json` client:

```json
{
  "mcpServers": {
    "urumi": {
      "command": "npx",
      "args": ["-y", "wook8-mcp", "connect"],
      "env": { "URUMI_GATEWAY_URL": "https://app.example.com", "URUMI_API_KEY": "ugw_..." }
    }
  }
}
```

## `woo`: WooCommerce tools for your own store

Five tools: `list_products`, `create_product`, `list_orders` (with `date: "today"` in the
store's timezone), `get_order`, `update_order_status`.

```json
{
  "mcpServers": {
    "woocommerce": {
      "command": "npx",
      "args": ["-y", "wook8-mcp", "woo"],
      "env": {
        "WOO_URL": "https://shop.example.com",
        "WOO_CONSUMER_KEY": "ck_...",
        "WOO_CONSUMER_SECRET": "cs_...",
        "STORE_TIMEZONE": "Asia/Kolkata"
      }
    }
  }
}
```

Create the key in **WooCommerce → Settings → Advanced → REST API** with read/write
permission. Over HTTPS it is sent as HTTP Basic auth; over plain HTTP only an OAuth
1.0a signature is sent, never the secret.

## Environment

| Variable | Used by | Meaning |
| --- | --- | --- |
| `URUMI_GATEWAY_URL` | connect, config | Gateway address, with or without `/mcp` |
| `URUMI_API_KEY` | connect, config | Your personal key (`ugw_...`) from the dashboard |
| `WOO_URL` | woo | Store address |
| `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` | woo | WooCommerce REST key |
| `STORE_TIMEZONE` | woo | IANA timezone that defines "today" (default `UTC`) |

Node 20 or newer. MIT licensed.
