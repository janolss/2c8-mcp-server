import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { jsonBody, repositoryId, uuid } from "./schemas.js";

export function registerDescriptionReadTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_description_types",
    {
      description: "List description types in a repository",
      inputSchema: { repositoryId },
    },
    async ({ repositoryId: id }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/description-types",
          pathParams: { repositoryId: id },
        }),
      ),
  );

  server.registerTool(
    "list_model_descriptions",
    {
      description: "List descriptions attached to a model",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
      },
    },
    async ({ repositoryId: id, modelId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/descriptions",
          pathParams: { repositoryId: id, modelId },
        }),
      ),
  );

  server.registerTool(
    "get_model_description",
    {
      description: "Get one model description by description type",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        descriptionTypeId: uuid.describe("Description type UUID"),
      },
    },
    async ({ repositoryId: id, modelId, descriptionTypeId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/descriptions/{descriptionTypeId}",
          pathParams: { repositoryId: id, modelId, descriptionTypeId },
        }),
      ),
  );

  server.registerTool(
    "list_symbol_descriptions",
    {
      description: "List descriptions attached to a symbol",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
      },
    },
    async ({ repositoryId: id, symbolId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}/descriptions",
          pathParams: { repositoryId: id, symbolId },
        }),
      ),
  );

  server.registerTool(
    "get_symbol_description",
    {
      description: "Get one symbol description by description type",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
        descriptionTypeId: uuid.describe("Description type UUID"),
      },
    },
    async ({ repositoryId: id, symbolId, descriptionTypeId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}/descriptions/{descriptionTypeId}",
          pathParams: { repositoryId: id, symbolId, descriptionTypeId },
        }),
      ),
  );

  server.registerTool(
    "list_languages",
    {
      description: "List languages configured for a repository",
      inputSchema: { repositoryId },
    },
    async ({ repositoryId: id }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/languages",
          pathParams: { repositoryId: id },
        }),
      ),
  );
}

export function registerDescriptionWriteTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "update_model_description",
    {
      description: "Create or update a model description",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        descriptionTypeId: uuid.describe("Description type UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, modelId, descriptionTypeId, body }) =>
      runTool(() =>
        client.request({
          method: "PATCH",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/descriptions/{descriptionTypeId}",
          pathParams: { repositoryId: id, modelId, descriptionTypeId },
          body,
        }),
      ),
  );

  server.registerTool(
    "update_symbol_description",
    {
      description: "Create or update a symbol description",
      inputSchema: {
        repositoryId,
        symbolId: uuid.describe("Symbol UUID"),
        descriptionTypeId: uuid.describe("Description type UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, symbolId, descriptionTypeId, body }) =>
      runTool(() =>
        client.request({
          method: "PATCH",
          path: "/api/v1/repositories/{repositoryId}/symbols/{symbolId}/descriptions/{descriptionTypeId}",
          pathParams: { repositoryId: id, symbolId, descriptionTypeId },
          body,
        }),
      ),
  );
}
