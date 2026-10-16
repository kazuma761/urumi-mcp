import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

// Addresses an admin-entered URL must not reach: loopback, private networks
// (which is where pods and Services live), link-local (cloud metadata at
// 169.254.169.254), carrier-grade NAT, and their IPv6 equivalents.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.168.0.0", 16],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 127], ["fc00::", 7], ["fe80::", 10]] as const) blocked.addSubnet(net, bits, "ipv6");

export const isBlockedAddress = (address: string) => blocked.check(address, isIP(address) === 6 ? "ipv6" : "ipv4");

/**
 * Rejects URLs that would make the gateway call something internal (SSRF).
 * `allowedHosts` are in-cluster upstreams the operator opted in through Helm values.
 * shortcut: checked when a server is saved and again on every connect, but the
 * HTTP client resolves DNS once more itself, so a hostname that flips its answer
 * between the two lookups is not caught. Upgrade: pin the resolved IP in a custom dispatcher.
 */
export async function assertSafeUrl(raw: string, allowedHosts: string[]): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL must be http or https");
  if (url.username || url.password) throw new Error("URL must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (allowedHosts.includes(host)) return;
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (addresses.length === 0) throw new Error(`${host} does not resolve`);
  if (addresses.some(isBlockedAddress)) throw new Error(`${host} is an internal address and is blocked`);
}
