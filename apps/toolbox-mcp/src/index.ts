// A small second upstream for the gateway. It exists to show two things the
// WooCommerce server cannot: a custom-header credential, and a tool name
// ("echo") that collides with another upstream's.
import { createHash, timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import express from "express";
import * as z from "zod";

const API_KEY = process.env.TOOLBOX_API_KEY;
if (!API_KEY) throw new Error("missing env TOOLBOX_API_KEY");
const PORT = Number(process.env.PORT ?? 3000);

const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(API_KEY);
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: "toolbox", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo a message back, upper-cased.", inputSchema: z.object({ message: z.string() }), annotations: { readOnlyHint: true } },
    ({ message }) => text(message.toUpperCase()),
  );
  server.registerTool(
    "current_time",
    {
      description: "Current date and time in an IANA timezone (default UTC).",
      inputSchema: z.object({ timezone: z.string().default("UTC") }),
      annotations: { readOnlyHint: true },
    },
    ({ timezone }) => {
      try {
        return text(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, dateStyle: "full", timeStyle: "long" }).format(new Date()));
      } catch {
        return { ...text(`Unknown timezone: ${timezone}`), isError: true };
      }
    },
  );
  server.registerTool(
    "percent_of",
    {
      description: "Compute what percentage `part` is of `total`.",
      inputSchema: z.object({ part: z.number(), total: z.number() }),
      annotations: { readOnlyHint: true },
    },
    ({ part, total }) => (total === 0 ? { ...text("total must not be 0"), isError: true } : text(`${((part / total) * 100).toFixed(2)}%`)),
  );
  server.registerTool(
    "wait",
    {
      description: "Wait the given number of seconds, then answer. Exists to demonstrate the gateway's call timeout.",
      inputSchema: z.object({ seconds: z.number().min(0).max(120) }),
      annotations: { readOnlyHint: true },
    },
    async ({ seconds }) => {
      await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
      return text(`waited ${seconds}s`);
    },
  );
  return server;
}

const mcp = toNodeHandler(createMcpHandler(buildServer));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.get("/healthz", (_req, res) => void res.json({ ok: true }));
app.all("/mcp", (req, res) => {
  if (!timingSafeEqual(digest(req.header("x-api-key") ?? ""), expected)) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  void mcp(req, res, req.body);
});
const server = app.listen(PORT, () => console.log(`toolbox-mcp listening on :${PORT}`));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
