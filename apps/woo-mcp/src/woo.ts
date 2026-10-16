import { createHmac, randomBytes } from "node:crypto";

const env = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

const BASE_URL = env("WOO_URL").replace(/\/$/, "");
// In the cluster, requests go to the WordPress Service over plain HTTP, but
// WooCommerce verifies the signature against its public home URL (always http,
// because TLS ends at the Ingress). Outside a cluster the store is its own host.
const SIGN_URL = `http://${process.env.WOO_PUBLIC_HOST || new URL(BASE_URL).host}`;
const KEY = env("WOO_CONSUMER_KEY");
const SECRET = env("WOO_CONSUMER_SECRET");
const TIMEOUT_MS = Number(process.env.WOO_TIMEOUT_MS ?? 15000);

/** An error whose message is safe to hand to an MCP client and a model. */
export class WooError extends Error {}

// RFC 3986 encoding, same as PHP rawurlencode: encodeURIComponent leaves !'()* alone.
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * OAuth 1.0a "one-legged" signature. WooCommerce only accepts Basic auth over
 * HTTPS; over plain HTTP it requires this, so the consumer secret is never sent.
 */
export function sign(
  method: string,
  url: string,
  query: Record<string, string>,
  key: string,
  secret: string,
  nonce = randomBytes(16).toString("hex"),
  timestamp = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const params: Record<string, string> = {
    ...query,
    oauth_consumer_key: key,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA256",
    oauth_timestamp: String(timestamp),
  };
  const paramString = Object.keys(params)
    .sort()
    .map((k) => `${enc(k)}=${enc(params[k]!)}`)
    .join("&");
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join("&");
  const oauth_signature = createHmac("sha256", `${secret}&`).update(base).digest("base64");
  return { ...params, oauth_signature };
}

/**
 * Query string and headers that authenticate one request. Over HTTPS WooCommerce
 * takes the key as HTTP Basic auth; over plain HTTP it only accepts an OAuth 1.0a
 * signature, so the consumer secret never crosses the wire.
 */
export function authenticate(
  method: string,
  route: string,
  query: Record<string, string>,
  base = BASE_URL,
): { query: Record<string, string>; headers: Record<string, string> } {
  if (base.startsWith("https://")) {
    return { query, headers: { Authorization: `Basic ${Buffer.from(`${KEY}:${SECRET}`).toString("base64")}` } };
  }
  return { query: sign(method, SIGN_URL + route, query, KEY, SECRET), headers: {} };
}

/** Calls the WooCommerce REST API (wc/v3). `total` is the match count across all pages, for lists. */
export async function woo<T>(
  method: "GET" | "POST" | "PUT",
  path: string,
  query: Record<string, string | number | undefined> = {},
  body?: unknown,
): Promise<{ data: T; total: number | null }> {
  const route = `/wp-json/wc/v3${path}`;
  const plain: Record<string, string> = {};
  for (const [k, v] of Object.entries(query)) if (v !== undefined) plain[k] = String(v);
  const auth = authenticate(method, route, plain);

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${route}?${new URLSearchParams(auth.query)}`, {
      method,
      headers: { Accept: "application/json", ...auth.headers, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") throw new WooError(`Store did not respond within ${TIMEOUT_MS / 1000}s`);
    throw new WooError("Store is unreachable");
  }
  const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
  if (res.ok && json !== null) return { data: json, total: res.headers.has("x-wp-total") ? Number(res.headers.get("x-wp-total")) : null };
  if (res.status === 401 || res.status === 403) throw new WooError("Store rejected the MCP server's credentials");
  if (res.status === 404) throw new WooError("Not found");
  // WooCommerce error messages can contain HTML; strip it before it reaches a model.
  const message = json?.message?.replace(/<[^>]*>/g, "").slice(0, 300);
  throw new WooError(message || `Store returned HTTP ${res.status}`);
}

/** Today's date (YYYY-MM-DD) in the store's timezone. */
export const todayIn = (timeZone: string, now = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

/**
 * WooCommerce reads `after`/`before` in the store's timezone and treats both as
 * exclusive, so one whole day is bounded by the second before and after it.
 */
export function dayBounds(date: string): { after: string; before: string } {
  const d = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) {
    throw new WooError(`"${date}" is not a date; use YYYY-MM-DD or "today"`);
  }
  const shift = (days: number) => new Date(d.getTime() + days * 86_400_000).toISOString().slice(0, 10);
  return { after: `${shift(-1)}T23:59:59`, before: `${shift(1)}T00:00:00` };
}
