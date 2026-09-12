export type TransportMode = "stdio" | "http";

export interface AppConfig {
  baseUrl: string;
  apiKey: string;
  allowWrites: boolean;
  transport: TransportMode;
  port: number;
  host: string;
}

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(argv: string[] = process.argv.slice(2)): AppConfig {
  const wantsHttp =
    argv.includes("--http") ||
    process.env.MCP_TRANSPORT?.trim().toLowerCase() === "http";

  const baseUrl = requireEnv("TWO_C8_BASE_URL").replace(/\/+$/, "");
  const apiKey = requireEnv("TWO_C8_API_KEY");
  const allowWrites = parseBool(process.env.TWO_C8_ALLOW_WRITES, false);
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  const host = process.env.HOST?.trim() || "127.0.0.1";

  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }

  return {
    baseUrl,
    apiKey,
    allowWrites,
    transport: wantsHttp ? "http" : "stdio",
    port,
    host,
  };
}
