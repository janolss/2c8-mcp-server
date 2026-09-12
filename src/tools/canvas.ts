import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import { jsonBody, pagination, repositoryId, uuid } from "./schemas.js";

export function registerCanvasReadTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "get_canvas",
    {
      description: "Get the canvas for a model",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
      },
    },
    async ({ repositoryId: id, modelId }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
          pathParams: { repositoryId: id, modelId },
        }),
      ),
  );

  server.registerTool(
    "list_vertices",
    {
      description: "List vertices on a model canvas",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        sortLanguage: uuid.optional().describe("Language UUID used for sorting"),
        ...pagination,
      },
    },
    async ({ repositoryId: id, modelId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices",
          pathParams: { repositoryId: id, modelId },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_vertex",
    {
      description: "Get a canvas vertex by UUID",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        vertexId: uuid.describe("Vertex UUID"),
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, modelId, vertexId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices/{vertexId}",
          pathParams: { repositoryId: id, modelId, vertexId },
          query,
        }),
      ),
  );
}

export function registerCanvasWriteTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "update_canvas",
    {
      description: "Partially update a model canvas",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, modelId, body }) =>
      runTool(() =>
        client.request({
          method: "PATCH",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
          pathParams: { repositoryId: id, modelId },
          body,
        }),
      ),
  );

  server.registerTool(
    "create_vertex",
    {
      description: "Create a vertex on a model canvas",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, modelId, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices",
          pathParams: { repositoryId: id, modelId },
          body,
        }),
      ),
  );

  server.registerTool(
    "delete_vertex",
    {
      description: "Delete a canvas vertex",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        vertexId: uuid.describe("Vertex UUID"),
      },
    },
    async ({ repositoryId: id, modelId, vertexId }) =>
      runTool(() =>
        client.request({
          method: "DELETE",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices/{vertexId}",
          pathParams: { repositoryId: id, modelId, vertexId },
        }),
      ),
  );

  server.registerTool(
    "create_edge",
    {
      description: "Create an edge on a model canvas",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, modelId, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/edges",
          pathParams: { repositoryId: id, modelId },
          body,
        }),
      ),
  );

  server.registerTool(
    "delete_edge",
    {
      description: "Delete a canvas edge",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        edgeId: uuid.describe("Edge UUID"),
      },
    },
    async ({ repositoryId: id, modelId, edgeId }) =>
      runTool(() =>
        client.request({
          method: "DELETE",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/edges/{edgeId}",
          pathParams: { repositoryId: id, modelId, edgeId },
        }),
      ),
  );
}
