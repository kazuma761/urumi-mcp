import { and, count, eq, notInArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as z from "zod";
import { config } from "./config.ts";
import { encrypt, hashPassword, tryDecrypt } from "./crypto.ts";
import { servers, users } from "./lib/schema.ts";

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
export const db = drizzle(pool);

/** Tool-name prefix. No underscores, so "<slug>__<tool>" always splits at the first "__". */
export const SLUG = /^[a-z][a-z0-9-]{1,30}$/;

/** Applies pending migrations. The advisory lock makes replicas that start together take turns. */
export async function migrateDb(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await migrate(drizzle(client), { migrationsFolder: new URL("../drizzle", import.meta.url).pathname });
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    client.release();
  }
}

const seedSchema = z.array(
  z.object({
    slug: z.string().regex(SLUG),
    name: z.string().min(1),
    url: z.url(),
    authType: z.enum(["none", "bearer", "header"]).default("none"),
    authHeader: z.string().optional(),
    credential: z.string().optional(),
  }),
);

/** Creates the first admin and applies the servers declared in Helm values. Safe to run on every start. */
export async function seed(): Promise<void> {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
  if (n === 0) {
    await db
      .insert(users)
      .values({ email: config.adminEmail.toLowerCase(), role: "admin", passwordHash: await hashPassword(config.adminPassword) });
  }

  const seeds = seedSchema.parse(JSON.parse(config.seedServers));
  const existing = await db.select().from(servers);
  for (const s of seeds) {
    const row = existing.find((r) => r.slug === s.slug);
    const wanted = { name: s.name, url: s.url, authType: s.authType, authHeader: s.authHeader ?? null };
    // Skip untouched rows: bumping updatedAt makes every replica reconnect that upstream.
    const unchanged =
      row?.managed &&
      row.name === wanted.name &&
      row.url === wanted.url &&
      row.authType === wanted.authType &&
      row.authHeader === wanted.authHeader &&
      // A credential that no longer decrypts (the key changed) counts as changed and is written again.
      (row.credentialEnc ? tryDecrypt(row.credentialEnc) : undefined) === s.credential;
    if (unchanged) continue;
    const values = { ...wanted, credentialEnc: s.credential ? encrypt(s.credential) : null, managed: true, updatedAt: new Date() };
    // `enabled` is left alone on update: disabling a managed server in the dashboard must survive restarts.
    await db.insert(servers).values({ slug: s.slug, ...values }).onConflictDoUpdate({ target: servers.slug, set: values });
  }
  // A server dropped from the values stops being managed, so an admin can remove it.
  const slugs = seeds.map((s) => s.slug);
  await db
    .update(servers)
    .set({ managed: false })
    .where(slugs.length ? and(eq(servers.managed, true), notInArray(servers.slug, slugs)) : eq(servers.managed, true));
}
