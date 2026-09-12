import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";

export function registerMetaTools(server: McpServer, client: TwoC8Client): void {
  server.registerTool(
    "get_api_versions",
    {
      description: "Get backend/API version information",
      inputSchema: {},
    },
    async () =>
      runTool(() =>
        client.request({
          path: "/api/v1/versions",
        }),
      ),
  );
}
