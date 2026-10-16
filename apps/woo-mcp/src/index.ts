import { createHash, timingSafeEqual } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";
import express from "express";
import { buildServer } from "./tools.ts";

const TOKEN = process.env.MCP_BEARER_TOKEN;
if (!TOKEN) throw new Error("missing env MCP_BEARER_TOKEN");
const PORT = Number(process.env.PORT ?? 3000);

// Hash both sides so the comparison is constant-time whatever the lengths.
const digest = (s: string) => createHash("sha256").update(s).digest();
const expected = digest(TOKEN);

// Stateless MCP over Streamable HTTP: a fresh server per request, so no
// session lives in the pod and any replica can answer any request.
const mcp = toNodeHandler(createMcpHandler(buildServer));

const app = express();
app.use(express.json({ limit: "1mb" }));

// Liveness/readiness report on this process only. If the store is down the
// tools answer "Store is unreachable" instead of the pod leaving the Service.
app.get("/healthz", (_req, res) => void res.json({ ok: true }));

app.all("/mcp", (req, res) => {
  const presented = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1] ?? "";
  if (!timingSafeEqual(digest(presented), expected)) {
    res.status(401).set("WWW-Authenticate", "Bearer").json({ error: "unauthorized" });
    return;
  }
  void mcp(req, res, req.body);
});

const server = app.listen(PORT, () => console.log(`woo-mcp listening on :${PORT}`));
// Kubernetes sends SIGTERM before removing the pod; finish in-flight requests.
process.on("SIGTERM", () => server.close(() => process.exit(0)));
