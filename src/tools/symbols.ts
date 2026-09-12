import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { jsonBody, pagination, repositoryId, uuid } from "./schemas.js";

export function registerSymbolReadTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_symbols",
    {
      description: "List symbols in a repository",
      inputSchema: {
        repositoryId,
        sortLanguage: uuid.optional().describe("Language UUID used for sorting"),
        ...pagination,
      },
    },
    async ({ repositoryId: id, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/symbols",
          pathParams: { repositoryId: id },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_symbol",
    {
      description: "Get a symbol by UUID",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, symbolId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}",
          pathParams: { repositoryId: id, symbolId },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_symbol_properties",
    {
      description: "List properties for a symbol and property provider",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
        providerId: uuid.describe("Property provider UUID"),
      },
    },
    async ({ repositoryId: id, symbolId, providerId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}/properties/{providerId}",
          pathParams: { repositoryId: id, symbolId, providerId },
        }),
      ),
  );
}

export function registerSymbolWriteTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "create_symbol",
    {
      description: "Create a symbol in a repository",
      inputSchema: {
        repositoryId,
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/symbols",
          pathParams: { repositoryId: id },
          body,
        }),
      ),
  );

  server.registerTool(
    "update_symbol",
    {
      description: "Partially update a symbol",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, symbolId, body }) =>
      runTool(() =>
        client.request({
          method: "PATCH",
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}",
          pathParams: { repositoryId: id, symbolId },
          body,
        }),
      ),
  );

  server.registerTool(
    "delete_symbol",
    {
      description: "Delete a symbol",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
      },
    },
    async ({ repositoryId: id, symbolId }) =>
      runTool(() =>
        client.request({
          method: "DELETE",
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}",
          pathParams: { repositoryId: id, symbolId },
        }),
      ),
  );
}
