import assert from "node:assert/strict";
import { test } from "node:test";
import { endpointOf } from "./endpoint.ts";

test("a site URL or the endpoint itself both resolve to the /mcp endpoint", () => {
  assert.equal(endpointOf("https://app.example.com"), "https://app.example.com/mcp");
  assert.equal(endpointOf("https://app.example.com/"), "https://app.example.com/mcp");
  assert.equal(endpointOf("https://app.example.com/mcp"), "https://app.example.com/mcp");
  assert.equal(endpointOf("http://app.127.0.0.1.nip.io/mcp/"), "http://app.127.0.0.1.nip.io/mcp");
});
