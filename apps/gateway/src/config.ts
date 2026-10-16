const required = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};
const int = (name: string, fallback: number) => Number(process.env[name] ?? fallback);

export const config = {
  port: int("PORT", 8080),
  databaseUrl: required("DATABASE_URL"),
  // Signs dashboard session cookies.
  sessionSecret: required("SESSION_SECRET"),
  // 32 bytes, base64: encrypts upstream credentials at rest.
  encryptionKey: Buffer.from(required("ENCRYPTION_KEY"), "base64"),
  cookieSecure: process.env.COOKIE_SECURE === "true",
  adminEmail: required("ADMIN_EMAIL"),
  adminPassword: required("ADMIN_PASSWORD"),
  // Servers declared in Helm values, as JSON (includes their credentials).
  seedServers: process.env.SEED_SERVERS ?? "[]",
  // Hosts an admin may register even though they resolve to private addresses.
  allowedHosts: (process.env.UPSTREAM_ALLOWED_HOSTS ?? "").split(",").filter(Boolean),
  callTimeoutMs: int("UPSTREAM_CALL_TIMEOUT_MS", 30_000),
  connectTimeoutMs: int("UPSTREAM_CONNECT_TIMEOUT_MS", 5_000),
  healthIntervalMs: int("UPSTREAM_HEALTH_INTERVAL_MS", 5_000),
  llm: {
    baseUrl: process.env.LLM_BASE_URL ?? "https://openrouter.ai/api/v1",
    model: process.env.LLM_MODEL ?? "anthropic/claude-haiku-5.5",
    apiKey: process.env.LLM_API_KEY ?? "",
    maxSteps: int("LLM_MAX_STEPS", 8),
  },
  dashboardDir: process.env.DASHBOARD_DIR ?? "",
};
if (config.encryptionKey.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes, base64-encoded");
