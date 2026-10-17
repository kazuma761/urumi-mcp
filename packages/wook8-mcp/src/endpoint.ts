/** Accepts a site URL or the endpoint itself: "https://app.example.com" → "https://app.example.com/mcp". */
export function endpointOf(url: string): string {
  const trimmed = url.replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed : `${trimmed}/mcp`;
}
