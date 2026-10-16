import express, { type NextFunction, type Request, type Response } from "express";
import { api } from "./api.ts";
import { config } from "./config.ts";
import { migrateDb, pool, seed } from "./db.ts";
import { mcpRoute } from "./mcp.ts";
import * as registry from "./registry.ts";

await migrateDb();
await seed();
registry.start();

const app = express();
app.disable("x-powered-by");

// Liveness: the process answers. Readiness: it can also reach its database.
// Neither depends on an upstream: a dead upstream must not take the gateway out of service.
app.get("/healthz", (_req, res) => void res.json({ ok: true }));
app.get("/readyz", async (_req, res) => {
  try {
    await pool.query("select 1");
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.use((_req, res, next) => {
  // The dashboard loads only its own scripts and cannot be framed by another site.
  res.set({ "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  next();
});
// Only JSON bodies are parsed, so a cross-site HTML form cannot produce a valid API request.
app.use(express.json({ limit: "1mb" }));

app.all("/mcp", mcpRoute);
app.use("/api", api);
if (config.dashboardDir) app.use(express.static(config.dashboardDir));

app.use((err: { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
  // Malformed JSON and similar client errors carry their own status; the rest are ours.
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  if (res.headersSent) return void res.end();
  res.status(status).json({ error: status === 500 ? "Internal error" : "Bad request" });
});

const server = app.listen(config.port, () => console.log(`gateway listening on :${config.port}`));
// Kubernetes sends SIGTERM before removing the pod: stop accepting, finish in-flight requests, then exit.
process.on("SIGTERM", () => server.close(() => void pool.end().finally(() => process.exit(0))));
