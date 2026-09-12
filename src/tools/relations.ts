import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { pagination, repositoryId, uuid } from "./schemas.js";

export function registerRelationTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_relations",
    {
      description: "List custom relations in a repository",
      inputSchema: {
        repositoryId,
        ...pagination,
      },
    },
    async ({ repositoryId: id, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/relations",
          pathParams: { repositoryId: id },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_relation",
    {
      description: "Get a custom relation by UUID",
      inputSchema: {
        repositoryId,
        relationId: uuid.describe("Relation UUID"),
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, relationId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/relations/{relationId}",
          pathParams: { repositoryId: id, relationId },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_relation_script",
    {
      description: "Get the script for a custom relation",
      inputSchema: {
        repositoryId,
        relationId: uuid.describe("Relation UUID"),
      },
    },
    async ({ repositoryId: id, relationId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/relations/{relationId}/script",
          pathParams: { repositoryId: id, relationId },
        }),
      ),
  );
}
