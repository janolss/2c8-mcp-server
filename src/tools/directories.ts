import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { pagination, uuid } from "./schemas.js";

export function registerDirectoryTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_directories",
    {
      description: "List directories",
      inputSchema: { ...pagination },
    },
    async (args) =>
      runTool(() =>
        client.request({
          path: "/api/v1/directories",
          query: args,
        }),
      ),
  );

  server.registerTool(
    "get_directory",
    {
      description: "Get a directory by UUID",
      inputSchema: {
        directoryId: uuid.describe("Directory UUID"),
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ directoryId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/directories/{directoryId}",
          pathParams: { directoryId },
          query,
        }),
      ),
  );
}
