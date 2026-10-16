import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  DATABASE_URL: "postgres://unused/unused", // nothing here opens a connection
  SESSION_SECRET: "test-session-secret",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
  ADMIN_EMAIL: "admin@example.com",
  ADMIN_PASSWORD: "unused",
});
const { decrypt, encrypt, hashPassword, signSession, tryDecrypt, verifyPassword, verifySession } = await import("./crypto.ts");
const { assertSafeUrl, isBlockedAddress } = await import("./ssrf.ts");
const { splitName } = await import("./gateway.ts");
const { tooManyAttempts } = await import("./auth.ts");

test("credentials round-trip through encryption, and a tampered ciphertext is rejected", () => {
  const stored = encrypt("s3cret-token");
  assert.equal(decrypt(stored), "s3cret-token");
  assert.notEqual(encrypt("s3cret-token"), stored, "a fresh IV every time");
  assert.ok(!stored.includes("s3cret"));
  const [iv, tag, data] = stored.split(".") as [string, string, string];
  const flipped = Buffer.from(data, "base64");
  flipped[0]! ^= 1;
  const tampered = [iv, tag, flipped.toString("base64")].join(".");
  assert.throws(() => decrypt(tampered));
  assert.equal(tryDecrypt(tampered), null);
});

test("passwords verify only against their own hash; a user without a password never verifies", async () => {
  const hash = await hashPassword("correct horse");
  assert.equal(await verifyPassword("correct horse", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
  assert.equal(await verifyPassword("anything", null), false);
});

test("session cookies: valid, tampered and expired", () => {
  const cookie = signSession("user-1", 60_000);
  assert.equal(verifySession(cookie), "user-1");
  const [, signature] = cookie.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: "admin", exp: Date.now() + 60_000 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${signature}`), null);
  assert.equal(verifySession(signSession("user-1", -1)), null);
  assert.equal(verifySession("garbage"), null);
});

test("SSRF guard blocks internal addresses in every spelling", async () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    assert.equal(isBlockedAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "172.32.0.1", "2606:4700:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);

  for (const url of [
    "ftp://example.com/mcp",
    "http://user:pw@example.com/mcp",
    "http://127.0.0.1:5432/",
    "http://[::1]/mcp",
    "http://localhost/mcp",
    "http://0x7f.1/mcp", // the URL parser normalises this to 127.0.0.1
    "http://169.254.169.254/latest/meta-data",
    "not a url",
  ]) {
    await assert.rejects(assertSafeUrl(url, []), url);
  }
  // An in-cluster host the operator opted in through Helm values is let through without a lookup.
  await assertSafeUrl("http://toolbox.upstreams.svc:3000/mcp", ["toolbox.upstreams.svc"]);
  await assert.rejects(assertSafeUrl("http://toolbox.upstreams.svc:3000/mcp", []));
});

test("tool names split at the first separator, so upstream tool names may contain it", () => {
  assert.deepEqual(splitName("woo__list_orders"), { slug: "woo", tool: "list_orders" });
  assert.deepEqual(splitName("a__b__c"), { slug: "a", tool: "b__c" });
  assert.equal(splitName("no-separator"), null);
  assert.equal(splitName("__tool"), null);
});

test("attempt limiter allows the first ten and blocks the eleventh, per key", () => {
  for (let i = 0; i < 10; i++) assert.equal(tooManyAttempts("login:a@example.com"), false);
  assert.equal(tooManyAttempts("login:a@example.com"), true);
  assert.equal(tooManyAttempts("login:b@example.com"), false);
});
