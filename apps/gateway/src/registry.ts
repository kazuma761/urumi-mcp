import { Client, ProtocolError, SdkError, SdkErrorCode, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { config } from "./config.ts";
import { tryDecrypt } from "./crypto.ts";
import { db } from "./db.ts";
import { servers, type ServerRow } from "./lib/schema.ts";
import { assertSafeUrl } from "./ssrf.ts";

export type Status = "connected" | "unreachable" | "disabled";

/** A call that failed because of the upstream, with the audit outcome it maps to. */
export class UpstreamError extends Error {
  readonly outcome: "timeout" | "unreachable";
  constructor(outcome: "timeout" | "unreachable", message: string) {
    super(message);
    this.outcome = outcome;
  }
}

let listener = () => {};
/** Registers the callback fired whenever the set of exposed tools changes. */
export const onToolsChanged = (fn: () => void) => void (listener = fn);
/** Says the exposed tools changed: a server came, went or changed, or tool permissions were edited. */
export const toolsChanged = () => listener();

/**
 * One upstream MCP server: a long-lived client plus a cached tool list.
 * Listing tools for clients reads the cache, so it never waits on an upstream.
 */
export class Upstream {
  readonly row: ServerRow;
  tools: Tool[] = [];
  error: string | null = null;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private checking: Promise<void> | null = null;
  private closed = false;

  constructor(row: ServerRow) {
    this.row = row;
  }

  get status(): Status {
    return !this.row.enabled ? "disabled" : this.client ? "connected" : "unreachable";
  }

  /**
   * Health check and cache refresh in one: connect if needed, then tools/list.
   * Concurrent callers share the same in-flight check.
   */
  check(): Promise<void> {
    this.checking ??= this.doCheck().finally(() => (this.checking = null));
    return this.checking;
  }

  private async doCheck(): Promise<void> {
    if (!this.row.enabled || this.closed) return;
    const before = this.signature();
    try {
      if (!this.client) await this.connect();
      const { tools } = await this.client!.listTools(undefined, { timeout: config.connectTimeoutMs, cacheMode: "refresh" });
      this.tools = tools;
      this.error = null;
    } catch (err) {
      this.error = explain(err);
      this.drop();
    }
    // Replaced or removed while the check was in flight: this object must not come back to life.
    if (this.closed) this.drop();
    else if (this.signature() !== before) toolsChanged();
  }

  private signature(): string {
    return this.status + JSON.stringify(this.tools);
  }

  private async connect(): Promise<void> {
    // Managed servers come from Helm values and are trusted. A URL an admin typed is
    // re-checked on every connect, because what its host name resolves to can change.
    if (!this.row.managed) await assertSafeUrl(this.row.url, config.allowedHosts);
    const credential = this.row.credentialEnc ? tryDecrypt(this.row.credentialEnc) : null;
    if (this.row.credentialEnc && credential === null) {
      throw new Error("The stored credential cannot be decrypted (the encryption key changed). Enter it again.");
    }
    const headers: Record<string, string> = {};
    if (credential && this.row.authType === "bearer") headers.Authorization = `Bearer ${credential}`;
    if (credential && this.row.authType === "header" && this.row.authHeader) headers[this.row.authHeader] = credential;

    // Redirects are refused: an upstream must not be able to bounce the gateway,
    // and the credential it carries, to another host.
    const transport = new StreamableHTTPClientTransport(new URL(this.row.url), { requestInit: { headers, redirect: "error" } });
    const client = new Client({ name: "urumi-gateway", version: "1.0.0" });
    try {
      await client.connect(transport, { timeout: config.connectTimeoutMs });
    } catch (err) {
      void client.close().catch(() => undefined);
      throw err;
    }
    this.client = client;
    this.transport = transport;
  }

  async call(tool: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!this.client) throw new UpstreamError("unreachable", `${this.row.name} is unreachable`);
    try {
      return (await this.client.callTool({ name: tool, arguments: args }, { timeout: config.callTimeoutMs })) as CallToolResult;
    } catch (err) {
      if (err instanceof SdkError && err.code === SdkErrorCode.RequestTimeout) {
        throw new UpstreamError("timeout", `${this.row.name} did not respond within ${config.callTimeoutMs / 1000}s`);
      }
      // The upstream answered with a JSON-RPC error (bad arguments, say): a failed call, not an outage.
      if (err instanceof ProtocolError) {
        return { content: [{ type: "text", text: `${this.row.name}: ${err.message}`.slice(0, 500) }], isError: true };
      }
      // Anything else is the transport failing. Re-check now instead of waiting for the next tick.
      void this.check();
      throw new UpstreamError("unreachable", `${this.row.name} is unreachable`);
    }
  }

  private drop(): void {
    const { client, transport } = this;
    this.client = null;
    this.transport = null;
    this.tools = [];
    // Ends the session on stateful upstreams; best effort.
    void transport?.terminateSession().catch(() => undefined).finally(() => client?.close().catch(() => undefined));
  }

  close(): void {
    this.closed = true;
    this.drop();
  }
}

/** Why an upstream failed, in words an admin can act on. Node hides the real reason in err.cause. */
function explain(err: unknown): string {
  const parts: string[] = [];
  let e = err as { code?: unknown; message?: string; cause?: unknown; errors?: unknown[] } | undefined;
  for (let depth = 0; e && depth < 4; depth++) {
    parts.push(String(e.code ?? ""), e.message ?? "");
    e = (e.cause ?? e.errors?.[0]) as typeof e;
  }
  const all = parts.join(" ");
  if (/blocked|not valid|must be|does not resolve|cannot be decrypted/.test(all)) return (err as Error).message;
  if (/ECONNREFUSED/.test(all)) return "Connection refused: nothing is listening at that address";
  if (/ENOTFOUND|EAI_AGAIN/.test(all)) return "DNS lookup failed: the host name does not resolve";
  if (/REQUEST_TIMEOUT|timed out|ETIMEDOUT|CONNECT_TIMEOUT/i.test(all)) return "Timed out waiting for the server";
  if (/\b40[13]\b|unauthorized/i.test(all)) return "The server rejected the credential";
  if (/\b404\b/.test(all)) return "No MCP endpoint at that URL (HTTP 404)";
  if (/redirect/i.test(all)) return "The server answered with a redirect, which is refused";
  return ((err as Error)?.message || "Unknown error").slice(0, 200);
}

const upstreams = new Map<string, Upstream>();

export const get = (slug: string) => upstreams.get(slug);
export const all = () => [...upstreams.values()].sort((a, b) => a.row.slug.localeCompare(b.row.slug));

async function doReload(): Promise<void> {
  const rows = await db.select().from(servers);
  let changed = false;
  for (const row of rows) {
    const current = upstreams.get(row.slug);
    // Every write to a server row bumps updatedAt, so it works as a version.
    if (current && current.row.id === row.id && current.row.updatedAt.getTime() === row.updatedAt.getTime()) continue;
    current?.close();
    upstreams.set(row.slug, new Upstream(row));
    changed = true;
  }
  for (const [slug, upstream] of upstreams) {
    if (rows.some((r) => r.slug === slug)) continue;
    upstream.close();
    upstreams.delete(slug);
    changed = true;
  }
  if (changed) toolsChanged();
}

let queue: Promise<void> = Promise.resolve();
/**
 * Makes the in-memory upstreams match the servers table. Runs one at a time.
 * The database is the source of truth, so every replica converges on it within
 * one tick without the replicas talking to each other.
 */
export function reload(): Promise<void> {
  queue = queue.then(doReload, doReload);
  return queue;
}

export function start(): void {
  const tick = async () => {
    await reload().catch((err) => console.error("registry reload failed:", err));
    for (const upstream of upstreams.values()) void upstream.check();
  };
  void tick();
  setInterval(tick, config.healthIntervalMs);
}
