import assert from "node:assert/strict";
import { test } from "node:test";

Object.assign(process.env, {
  WOO_URL: "http://wordpress",
  WOO_PUBLIC_HOST: "store.example.com",
  WOO_CONSUMER_KEY: "ck_abc",
  WOO_CONSUMER_SECRET: "cs_secret",
});
const { sign, dayBounds, todayIn, authenticate } = await import("./woo.ts");

test("OAuth signature matches a vector computed independently (Python hmac over a hand-built base string)", () => {
  const signed = sign(
    "GET",
    "http://store.example.com/wp-json/wc/v3/products",
    { per_page: "20", search: "blue tee (large)" },
    "ck_abc",
    "cs_secret",
    "n0nce",
    1700000000,
  );
  assert.equal(signed.oauth_signature, "JcqXVLysPZ1mvPHf6AcTS74qwFpVkc/q9M/d9PwnZeE=");
});

test("dayBounds covers one whole day with exclusive bounds, across a month end", () => {
  assert.deepEqual(dayBounds("2026-03-01"), { after: "2026-02-28T23:59:59", before: "2026-03-02T00:00:00" });
  assert.throws(() => dayBounds("2026-02-30"), /not a date/);
  assert.throws(() => dayBounds("yesterday"), /not a date/);
});

test("todayIn uses the store's timezone, not UTC", () => {
  const lateUtc = new Date("2026-10-11T20:00:00Z"); // already the 12th in Kolkata
  assert.equal(todayIn("Asia/Kolkata", lateUtc), "2026-10-12");
  assert.equal(todayIn("UTC", lateUtc), "2026-10-11");
});

test("HTTPS stores get Basic auth; plain HTTP gets an OAuth signature and never the secret", () => {
  const https = authenticate("GET", "/wp-json/wc/v3/orders", { page: "1" }, "https://shop.example.com");
  assert.equal(https.headers.Authorization, `Basic ${Buffer.from("ck_abc:cs_secret").toString("base64")}`);
  assert.deepEqual(https.query, { page: "1" });

  const http = authenticate("GET", "/wp-json/wc/v3/orders", { page: "1" }, "http://wordpress");
  assert.deepEqual(http.headers, {});
  assert.ok(http.query.oauth_signature);
  assert.ok(!JSON.stringify(http).includes("cs_secret"));
});
