import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.ts";

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A random secret with a recognisable prefix, e.g. API keys ("ugw_...") and invite tokens. */
export const newToken = (prefix: string) => prefix + randomBytes(32).toString("base64url");

// Passwords are low-entropy, so they get a slow, salted hash (scrypt). API keys
// are 256 random bits, where one SHA-256 is enough and keeps every MCP call fast.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `${salt.toString("hex")}:${(await scryptAsync(password, salt, 32)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // Unknown users still pay for one hash, so timing does not reveal which emails exist.
  const [salt, hash] = (stored ?? `${"0".repeat(32)}:${"0".repeat(64)}`).split(":") as [string, string];
  const actual = await scryptAsync(password, Buffer.from(salt, "hex"), 32);
  return timingSafeEqual(actual, Buffer.from(hash, "hex")) && stored !== null;
}

/** AES-256-GCM. Output is iv.tag.ciphertext, base64. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

/** Throws when the ciphertext was changed, or was written with a different key. */
export function decrypt(stored: string): string {
  const [iv, tag, data] = stored.split(".").map((p) => Buffer.from(p, "base64")) as [Buffer, Buffer, Buffer];
  const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** Like decrypt, but null instead of throwing: for callers that can carry on without the value. */
export function tryDecrypt(stored: string): string | null {
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

const mac = (payload: string) => createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");

/** Session cookie value: a signed {user id, expiry}. Nothing is stored server-side. */
export function signSession(userId: string, ttlMs: number): string {
  const payload = Buffer.from(JSON.stringify({ uid: userId, exp: Date.now() + ttlMs })).toString("base64url");
  return `${payload}.${mac(payload)}`;
}

export function verifySession(cookie: string): string | null {
  const [payload, signature] = cookie.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(mac(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const { uid, exp } = JSON.parse(Buffer.from(payload, "base64url").toString()) as { uid: string; exp: number };
  return exp > Date.now() ? uid : null;
}
