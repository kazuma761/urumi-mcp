import { boolean, integer, pgTable, serial, text, timestamp, uuid } from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const users = pgTable("users", {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  role: text({ enum: ["admin", "member"] }).notNull(),
  // Null until the invite is accepted; the user cannot log in before that.
  passwordHash: text("password_hash"),
  // SHA-256 of the pending invite token; cleared when it is used.
  inviteHash: text("invite_hash"),
  createdAt: createdAt(),
});

export const apiKeys = pgTable("api_keys", {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text().notNull(),
  // First characters of the key, shown so a user can tell their keys apart.
  prefix: text().notNull(),
  // SHA-256 of the whole key. The key itself is shown once and never stored.
  keyHash: text("key_hash").notNull().unique(),
  createdAt: createdAt(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const servers = pgTable("servers", {
  id: uuid().primaryKey().defaultRandom(),
  // Tool-name prefix: tools are exposed as "<slug>__<tool>".
  slug: text().notNull().unique(),
  name: text().notNull(),
  url: text().notNull(),
  authType: text("auth_type", { enum: ["none", "bearer", "header"] }).notNull().default("none"),
  authHeader: text("auth_header"),
  // AES-256-GCM ciphertext of the upstream credential.
  credentialEnc: text("credential_enc"),
  enabled: boolean().notNull().default(true),
  // Declared in Helm values: re-applied on every start, cannot be removed from the dashboard.
  managed: boolean().notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable("audit_log", {
  id: serial().primaryKey(),
  ts: timestamp({ withTimezone: true }).notNull().defaultNow(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  userEmail: text("user_email").notNull(),
  via: text({ enum: ["mcp", "chat"] }).notNull(),
  server: text(),
  tool: text(),
  durationMs: integer("duration_ms").notNull(),
  outcome: text({ enum: ["ok", "error", "timeout", "unreachable", "denied", "not_found", "rejected"] }).notNull(),
  error: text(),
});

// Tools members may not use, by exposed name ("<slug>__<tool>"). Admins are never restricted.
export const memberDeniedTools = pgTable("member_denied_tools", {
  tool: text().primaryKey(),
});

export type User = typeof users.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type ServerRow = typeof servers.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
