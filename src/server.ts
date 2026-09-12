import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "./config.js";
import { TwoC8Client } from "./client/twoc8-client.js";
import { registerAllTools } from "./tools/index.js";

export function createServer(config: AppConfig): McpServer {
  const server = new McpServer({
    name: "2c8-mcp-server",
    version: "1.0.0",
  });

  const client = new TwoC8Client(config.baseUrl, config.apiKey);
  registerAllTools(server, client, config.allowWrites);
  return server;
}
