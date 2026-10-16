import { eq } from "drizzle-orm";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.ts";
import { sha256, signSession, verifySession } from "./crypto.ts";
import { db } from "./db.ts";
import type { Principal } from "./gateway.ts";
import { apiKeys, users, type User } from "./lib/schema.ts";

const COOKIE = "urumi_session";
const SESSION_MS = 12 * 60 * 60 * 1000;

export function startSession(res: Response, userId: string): void {
  // httpOnly: scripts cannot read it. SameSite=Lax: other sites cannot make the browser send it on a POST.
  res.cookie(COOKIE, signSession(userId, SESSION_MS), {
    httpOnly: true,
    sameSite: "lax",
    secure: config.cookieSecure,
    maxAge: SESSION_MS,
    path: "/",
  });
}

export const endSession = (res: Response) => void res.clearCookie(COOKIE, { path: "/" });

/** The logged-in user, set by requireUser. */
export const me = (res: Response) => res.locals.user as User;

export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cookie = req.headers.cookie
    ?.split(/;\s*/)
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  const userId = cookie ? verifySession(cookie) : null;
  // Loaded on every request, so a role change applies at once.
  const [user] = userId ? await db.select().from(users).where(eq(users.id, userId)) : [];
  if (!user) {
    res.status(401).json({ error: "Not logged in" });
    return;
  }
  res.locals.user = user;
  next();
}

export function requireAdmin(_req: Request, res: Response, next: NextFunction): void {
  if (me(res).role === "admin") next();
  else res.status(403).json({ error: "Admins only" });
}

/**
 * Looks up the API key on a request. Checked on every request, so a revoked key
 * stops working on its very next call. A revoked key still identifies its owner,
 * which lets the rejected attempt be audited under their name.
 */
export async function keyOwner(req: Request): Promise<{ principal: Principal; revoked: boolean; prefix: string } | null> {
  const key = /^Bearer\s+(ugw_\S+)$/i.exec(req.headers.authorization ?? "")?.[1];
  if (!key) return null;
  const [row] = await db
    .select({ id: users.id, email: users.email, role: users.role, keyId: apiKeys.id, revokedAt: apiKeys.revokedAt, prefix: apiKeys.prefix })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyHash, sha256(key)));
  if (!row) return null;
  if (!row.revokedAt) void db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.keyId)).catch(() => undefined);
  return { principal: { id: row.id, email: row.email, role: row.role }, revoked: row.revokedAt !== null, prefix: row.prefix };
}

const attempts = new Map<string, { count: number; resetAt: number }>();
/**
 * At most `max` attempts per key in a window; used for password guessing.
 * shortcut: counted in this process only, so the real limit is max x replicas
 * and resets on restart. Upgrade: count in Postgres.
 */
export function tooManyAttempts(key: string, max = 10, windowMs = 5 * 60 * 1000): boolean {
  const now = Date.now();
  // Without this, every email ever tried would stay in memory.
  for (const [k, e] of attempts) if (e.resetAt < now) attempts.delete(k);
  const entry = attempts.get(key);
  if (!entry || entry.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  return ++entry.count > max;
}
