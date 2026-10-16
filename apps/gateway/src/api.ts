// The dashboard's HTTP API. Everything here is cookie-authenticated; MCP clients use /mcp instead.
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import express, { type Request, type Response } from "express";
import * as z from "zod";
import { endSession, me, requireAdmin, requireUser, startSession, tooManyAttempts } from "./auth.ts";
import { runChat } from "./chat.ts";
import { config } from "./config.ts";
import { encrypt, hashPassword, newToken, sha256, verifyPassword } from "./crypto.ts";
import { db, SLUG } from "./db.ts";
import { deniedTools, splitName } from "./gateway.ts";
import { apiKeys, auditLog, memberDeniedTools, servers, users, type ApiKey, type ServerRow, type User } from "./lib/schema.ts";
import * as registry from "./registry.ts";
import { assertSafeUrl } from "./ssrf.ts";

export const api = express.Router();

const fail = (res: Response, status: number, error: string) => void res.status(status).json({ error });

/** Validates the JSON body; answers 400 and returns null when it does not fit. */
function parse<T>(schema: z.ZodType<T>, req: Request, res: Response): T | null {
  const result = schema.safeParse(req.body);
  if (result.success) return result.data;
  fail(res, 400, result.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return null;
}

const isUuid = (s: string) => z.uuid().safeParse(s).success;
// Postgres error codes, wherever the driver or Drizzle put them.
const pgCode = (err: unknown) => (err as { cause?: { code?: string } }).cause?.code ?? (err as { code?: string }).code;

const userView = (u: User) => ({ id: u.id, email: u.email, role: u.role, pending: u.passwordHash === null, createdAt: u.createdAt });
const keyView = ({ id, name, prefix, createdAt, lastUsedAt, revokedAt }: ApiKey) => ({ id, name, prefix, createdAt, lastUsedAt, revokedAt });
const sendMe = (user: User, res: Response) => void res.json({ user: userView(user), chatEnabled: config.llm.apiKey !== "" });

// ---- Public routes -----------------------------------------------------------

api.post("/login", async (req, res) => {
  const input = parse(z.object({ email: z.string(), password: z.string() }), req, res);
  if (!input) return;
  const email = input.email.trim().toLowerCase();
  if (tooManyAttempts(`login:${email}`)) return fail(res, 429, "Too many attempts. Try again in a few minutes.");
  const [user] = await db.select().from(users).where(eq(users.email, email));
  if (!(await verifyPassword(input.password, user?.passwordHash ?? null)) || !user) return fail(res, 401, "Wrong email or password");
  startSession(res, user.id);
  sendMe(user, res);
});

api.post("/logout", (_req, res) => {
  endSession(res);
  res.status(204).end();
});

api.post("/invite/accept", async (req, res) => {
  const input = parse(z.object({ token: z.string().min(1), password: z.string().min(8).max(200) }), req, res);
  if (!input) return;
  // Single use: the same statement that sets the password clears the invite.
  const [user] = await db
    .update(users)
    .set({ passwordHash: await hashPassword(input.password), inviteHash: null })
    .where(eq(users.inviteHash, sha256(input.token)))
    .returning();
  if (!user) return fail(res, 400, "This invite link is not valid any more. Ask an admin for a new one.");
  startSession(res, user.id);
  sendMe(user, res);
});

// ---- Everything below needs a logged-in user ---------------------------------

api.use(requireUser);

api.get("/me", (_req, res) => sendMe(me(res), res));

// ---- Servers -----------------------------------------------------------------

function serverView(upstream: registry.Upstream, admin: boolean, denied: Set<string>) {
  const { id, slug, name, enabled, managed, url, authType, authHeader, credentialEnc } = upstream.row;
  const tools = upstream.tools
    .map((t) => ({ name: t.name, description: t.description ?? "", memberAllowed: !denied.has(`${slug}__${t.name}`) }))
    .filter((t) => admin || t.memberAllowed);
  return {
    id, slug, name, enabled, managed, status: upstream.status, tools,
    // Members never see where a server lives. Nobody ever gets the credential back.
    ...(admin ? { error: upstream.error, url, authType, authHeader, hasCredential: credentialEnc !== null } : {}),
  };
}

/** Reloads the registry, waits for the server's first health check, and answers with its view. */
async function sendServer(res: Response, slug: string, status = 200): Promise<void> {
  await registry.reload();
  const upstream = registry.get(slug)!;
  await upstream.check();
  res.status(status).json({ server: serverView(upstream, true, await deniedTools()) });
}

// Headers the MCP transport sets itself; a credential must not replace them.
const RESERVED_HEADER = /^(host|content-type|content-length|accept|connection|transfer-encoding|mcp-.*)$/i;
const authType = z.enum(["none", "bearer", "header"]);
const authHeader = z.string().regex(/^[A-Za-z0-9-]{1,64}$/, "letters, digits and hyphens only").refine((h) => !RESERVED_HEADER.test(h), "reserved header");
const serverName = z.string().trim().min(1).max(60);
const serverUrl = z.string().max(500);
const credential = z.string().min(1).max(4000);

/** The three credential columns for a server, or a message saying what is missing. */
function authColumns(
  input: { authType: ServerRow["authType"]; authHeader?: string | null; credential?: string },
  existing?: ServerRow,
): Pick<ServerRow, "authType" | "authHeader" | "credentialEnc"> | string {
  if (input.authType === "none") return { authType: "none", authHeader: null, credentialEnc: null };
  const header = input.authType === "header" ? (input.authHeader ?? existing?.authHeader ?? null) : null;
  if (input.authType === "header" && !header) return "authHeader is required for a header credential";
  const credentialEnc = input.credential ? encrypt(input.credential) : (existing?.credentialEnc ?? null);
  if (!credentialEnc) return "credential is required";
  return { authType: input.authType, authHeader: header, credentialEnc };
}

api.get("/servers", async (_req, res) => {
  await registry.reload();
  const admin = me(res).role === "admin";
  const denied = await deniedTools();
  res.json({ servers: registry.all().map((u) => serverView(u, admin, denied)) });
});

api.post("/servers", requireAdmin, async (req, res) => {
  const input = parse(
    z.object({
      slug: z.string().regex(SLUG, "2 to 31 characters: lowercase letters, digits and hyphens, starting with a letter"),
      name: serverName,
      url: serverUrl,
      authType: authType.default("none"),
      authHeader: authHeader.optional(),
      credential: credential.optional(),
    }),
    req,
    res,
  );
  if (!input) return;
  const auth = authColumns(input);
  if (typeof auth === "string") return fail(res, 400, auth);
  try {
    await assertSafeUrl(input.url, config.allowedHosts);
  } catch (err) {
    return fail(res, 400, (err as Error).message);
  }
  try {
    await db.insert(servers).values({ slug: input.slug, name: input.name, url: input.url, ...auth });
  } catch (err) {
    if (pgCode(err) === "23505") return fail(res, 409, `A server with slug "${input.slug}" already exists`);
    throw err;
  }
  await sendServer(res, input.slug, 201);
});

api.patch("/servers/:id", requireAdmin, async (req, res) => {
  const input = parse(
    z.object({ name: serverName, url: serverUrl, authType, authHeader: authHeader.nullable(), credential, enabled: z.boolean() }).partial(),
    req,
    res,
  );
  if (!input) return;
  const id = String(req.params.id);
  const [row] = isUuid(id) ? await db.select().from(servers).where(eq(servers.id, id)) : [];
  if (!row) return fail(res, 404, "Server not found");
  const { enabled, ...settings } = input;
  if (row.managed && Object.keys(settings).length > 0) {
    return fail(res, 409, "This server is declared in the Helm values. It can be enabled or disabled here; change the rest in the values.");
  }
  let auth = {};
  if (settings.authType !== undefined || settings.authHeader !== undefined || settings.credential !== undefined) {
    const columns = authColumns({ ...settings, authType: settings.authType ?? row.authType }, row);
    if (typeof columns === "string") return fail(res, 400, columns);
    auth = columns;
  }
  if (settings.url !== undefined) {
    try {
      await assertSafeUrl(settings.url, config.allowedHosts);
    } catch (err) {
      return fail(res, 400, (err as Error).message);
    }
  }
  await db
    .update(servers)
    .set({ name: settings.name ?? row.name, url: settings.url ?? row.url, enabled: enabled ?? row.enabled, ...auth, updatedAt: new Date() })
    .where(eq(servers.id, id));
  await sendServer(res, row.slug);
});

api.delete("/servers/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const [row] = isUuid(id) ? await db.select().from(servers).where(eq(servers.id, id)) : [];
  if (!row) return fail(res, 404, "Server not found");
  if (row.managed) return fail(res, 409, "This server is declared in the Helm values. Disable it here, or remove it from the values.");
  await db.delete(servers).where(eq(servers.id, id));
  // Its tool restrictions go with it, so they cannot silently apply to a later server that reuses the slug.
  await db.delete(memberDeniedTools).where(sql`starts_with(${memberDeniedTools.tool}, ${`${row.slug}__`})`);
  await registry.reload();
  res.status(204).end();
});

api.put("/tool-access", requireAdmin, async (req, res) => {
  const input = parse(z.object({ tool: z.string().max(200), memberAllowed: z.boolean() }), req, res);
  if (!input) return;
  if (!splitName(input.tool)) return fail(res, 400, "tool must look like <slug>__<tool>");
  if (input.memberAllowed) await db.delete(memberDeniedTools).where(eq(memberDeniedTools.tool, input.tool));
  else await db.insert(memberDeniedTools).values({ tool: input.tool }).onConflictDoNothing();
  registry.toolsChanged();
  res.status(204).end();
});

// ---- Team --------------------------------------------------------------------

api.get("/users", requireAdmin, async (_req, res) => {
  const everyone = await db.select().from(users).orderBy(users.createdAt);
  const keys = await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));
  res.json({ users: everyone.map((u) => ({ ...userView(u), keys: keys.filter((k) => k.userId === u.id).map(keyView) })) });
});

api.post("/users", requireAdmin, async (req, res) => {
  const input = parse(z.object({ email: z.email().max(200), role: z.enum(["admin", "member"]) }), req, res);
  if (!input) return;
  // Only the hash is stored: the link is shown to the admin once, like an API key.
  const inviteToken = newToken("inv_");
  try {
    const [user] = await db.insert(users).values({ email: input.email.toLowerCase(), role: input.role, inviteHash: sha256(inviteToken) }).returning();
    res.status(201).json({ user: userView(user!), inviteToken });
  } catch (err) {
    if (pgCode(err) === "23505") return fail(res, 409, "A user with that email already exists");
    throw err;
  }
});

api.post("/users/:id/invite", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  const inviteToken = newToken("inv_");
  // Replaces any earlier link. The current password, if there is one, keeps working until the new link is used.
  const [user] = isUuid(id) ? await db.update(users).set({ inviteHash: sha256(inviteToken) }).where(eq(users.id, id)).returning() : [];
  if (!user) return fail(res, 404, "User not found");
  res.json({ inviteToken });
});

api.delete("/users/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id);
  // Whoever removes people cannot remove themselves, so there is always an admin left.
  if (id === me(res).id) return fail(res, 409, "You cannot remove yourself");
  // The user's API keys go with the row (cascade), and their session dies on its next
  // request because the user it names is gone. Audit entries stay, with the email.
  const removed = isUuid(id) ? await db.delete(users).where(eq(users.id, id)).returning({ id: users.id }) : [];
  if (removed.length === 0) return fail(res, 404, "User not found");
  res.status(204).end();
});

// ---- API keys ----------------------------------------------------------------

api.get("/keys", async (_req, res) => {
  const keys = await db.select().from(apiKeys).where(eq(apiKeys.userId, me(res).id)).orderBy(desc(apiKeys.createdAt));
  res.json({ keys: keys.map(keyView) });
});

api.post("/keys", async (req, res) => {
  const input = parse(z.object({ name: z.string().trim().min(1).max(60), userId: z.uuid().optional() }), req, res);
  if (!input) return;
  const userId = input.userId ?? me(res).id;
  if (userId !== me(res).id && me(res).role !== "admin") return fail(res, 403, "Only admins can issue keys for someone else");
  const secret = newToken("ugw_");
  try {
    const [key] = await db.insert(apiKeys).values({ userId, name: input.name, prefix: secret.slice(0, 8), keyHash: sha256(secret) }).returning();
    // The only time the key leaves the server. Only its hash is kept.
    res.status(201).json({ key: keyView(key!), secret });
  } catch (err) {
    if (pgCode(err) === "23503") return fail(res, 404, "User not found");
    throw err;
  }
});

api.delete("/keys/:id", async (req, res) => {
  const id = String(req.params.id);
  const [key] = isUuid(id) ? await db.select().from(apiKeys).where(eq(apiKeys.id, id)) : [];
  // Someone else's key looks the same as a missing one.
  if (!key || (key.userId !== me(res).id && me(res).role !== "admin")) return fail(res, 404, "Key not found");
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt)));
  res.status(204).end();
});

// ---- Audit log ---------------------------------------------------------------

api.get("/audit", async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
  const own = me(res).role === "admin" ? undefined : eq(auditLog.userId, me(res).id);
  const rows = await db.select().from(auditLog).where(own).orderBy(desc(auditLog.id)).limit(limit);
  res.json({ entries: rows.map(({ userId: _, ...entry }) => entry) });
});

// ---- Chat --------------------------------------------------------------------

api.post("/chat", async (req, res) => {
  if (!config.llm.apiKey) return fail(res, 503, "Chat is not configured: set llm.apiKey in the platform values.");
  const input = parse(
    z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(20_000) })).min(1).max(100) }),
    req,
    res,
  );
  if (!input) return;
  // One JSON event per line, flushed as each step happens, so the page shows tool calls live.
  res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-cache" });
  const abort = new AbortController();
  res.on("close", () => abort.abort());
  const emit = (event: object) => void res.write(`${JSON.stringify(event)}\n`);
  try {
    // Only the most recent turns go to the model, so a long conversation keeps working.
    await runChat(me(res), input.messages.slice(-30), emit, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error("chat failed:", err);
      emit({ type: "error", message: `The model request failed: ${(err as Error).message}` });
    }
  }
  res.end();
});

api.use((_req, res) => fail(res, 404, "Not found"));
