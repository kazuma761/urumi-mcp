// The one path every tool call takes, whether it comes from an MCP client or
// from the chat agent: resolve the server, check permission, call, audit.
import type { CallToolResult, Tool } from "@modelcontextprotocol/client";
import { db } from "./db.ts";
import { auditLog, memberDeniedTools, type AuditRow, type User } from "./lib/schema.ts";
import * as registry from "./registry.ts";

export type Principal = Pick<User, "id" | "email" | "role">;

/** Splits "<slug>__<tool>" at the first "__". Slugs cannot contain "_", tool names may. */
export function splitName(name: string): { slug: string; tool: string } | null {
  const i = name.indexOf("__");
  return i > 0 ? { slug: name.slice(0, i), tool: name.slice(i + 2) } : null;
}

export async function deniedTools(): Promise<Set<string>> {
  return new Set((await db.select().from(memberDeniedTools)).map((r) => r.tool));
}

/** Tools of every connected server, prefixed with the server's slug, minus what this user may not use. */
export async function listTools(principal: Principal): Promise<Tool[]> {
  const denied = principal.role === "admin" ? new Set<string>() : await deniedTools();
  return registry
    .all()
    .filter((u) => u.status === "connected")
    .flatMap((u) =>
      u.tools.map((t) => ({
        ...t,
        name: `${u.row.slug}__${t.name}`,
        // The source is visible to the model; an upstream cannot pose as another server.
        description: `[${u.row.name}] ${t.description ?? ""}`.trim(),
      })),
    )
    .filter((t) => !denied.has(t.name));
}

const failure = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

export const textOf = (result: CallToolResult): string =>
  result.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("\n");

export async function audit(
  principal: Principal,
  via: AuditRow["via"],
  name: string,
  outcome: AuditRow["outcome"],
  durationMs: number,
  error: string | null,
): Promise<void> {
  const parts = splitName(name);
  await db.insert(auditLog).values({
    userId: principal.id,
    userEmail: principal.email,
    via,
    server: parts?.slug ?? null,
    tool: parts?.tool ?? name,
    durationMs,
    outcome,
    error: error?.slice(0, 500) ?? null,
  });
}

/** Routes one tool call to its upstream. Never throws for upstream problems: they become isError results. */
export async function callTool(
  principal: Principal,
  name: string,
  args: Record<string, unknown>,
  via: AuditRow["via"],
): Promise<CallToolResult> {
  const started = performance.now();
  const parts = splitName(name);
  const upstream = parts ? registry.get(parts.slug) : undefined;

  let outcome: AuditRow["outcome"];
  let result: CallToolResult;
  if (!parts || !upstream || !upstream.row.enabled) {
    [outcome, result] = ["not_found", failure(`Tool ${name} is not available`)];
  } else if (principal.role !== "admin" && (await deniedTools()).has(name)) {
    [outcome, result] = ["denied", failure(`You are not allowed to use ${name}`)];
  } else if (upstream.status !== "connected") {
    [outcome, result] = ["unreachable", failure(`${upstream.row.name} is unreachable`)];
  } else if (!upstream.tools.some((t) => t.name === parts.tool)) {
    [outcome, result] = ["not_found", failure(`Tool ${name} is not available`)];
  } else {
    try {
      result = await upstream.call(parts.tool, args);
      outcome = result.isError ? "error" : "ok";
    } catch (err) {
      outcome = err instanceof registry.UpstreamError ? err.outcome : "unreachable";
      result = failure((err as Error).message);
    }
  }
  // Awaited: the caller never gets a result that is not in the audit log.
  await audit(principal, via, name, outcome, Math.round(performance.now() - started), outcome === "ok" ? null : textOf(result));
  return result;
}
