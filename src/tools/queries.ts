import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { jsonBody, pagination, repositoryId, uuid } from "./schemas.js";

export function registerQueryTools(server: McpServer, client: TwoC8Client): void {
  server.registerTool(
    "execute_query",
    {
      description:
        "Execute a repository query (analysis). Allowed in read-only mode.",
      inputSchema: {
        repositoryId,
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/queries/execute",
          pathParams: { repositoryId: id },
          body,
        }),
      ),
  );

  server.registerTool(
    "get_lists",
    {
      description: "List saved lists in a repository",
      inputSchema: {
        repositoryId,
        ...pagination,
      },
    },
    async ({ repositoryId: id, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/lists",
          pathParams: { repositoryId: id },
          query,
        }),
      ),
  );

  server.registerTool(
    "execute_list",
    {
      description:
        "Execute a list definition (analysis). Allowed in read-only mode. Provide listId for a saved list, or body for an ad-hoc list.",
      inputSchema: {
        repositoryId,
        listId: uuid.optional().describe("Saved list UUID"),
        body: jsonBody.optional(),
      },
    },
    async ({ repositoryId: id, listId, body }) =>
      runTool(() => {
        if (listId) {
          return client.request({
            method: "POST",
            path: "/api/v1/repositories/{repositoryId}/lists/{listId}/execute",
            pathParams: { repositoryId: id, listId },
            body: body ?? {},
          });
        }
        if (!body) {
          throw new Error("Either listId or body is required for execute_list");
        }
        return client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/lists/execute",
          pathParams: { repositoryId: id },
          body,
        });
      }),
  );
}
