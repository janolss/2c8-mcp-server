import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { pagination, repositoryId } from "./schemas.js";

export function registerRepositoryTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_repositories",
    {
      description: "List repositories available to the API key",
      inputSchema: { ...pagination },
    },
    async (args) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories",
          query: args,
        }),
      ),
  );

  server.registerTool(
    "get_repository",
    {
      description: "Get a repository by UUID",
      inputSchema: {
        repositoryId,
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}",
          pathParams: { repositoryId: id },
          query,
        }),
      ),
  );
}
