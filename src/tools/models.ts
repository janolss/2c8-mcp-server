import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { runTool } from "../util/tool-result.js";
import {
  jsonBody,
  pagination,
  permissionGroupHeader,
  repositoryId,
  uuid,
} from "./schemas.js";

const versionNumber = z
  .union([z.string(), z.number()])
  .transform(String)
  .describe("Version number");

export function registerModelReadTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "list_models",
    {
      description: "List models in a repository",
      inputSchema: {
        repositoryId,
        sortLanguage: uuid.optional().describe("Language UUID used for sorting"),
        ...pagination,
      },
    },
    async ({ repositoryId: id, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models",
          pathParams: { repositoryId: id },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_model",
    {
      description: "Get a model by UUID",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, modelId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}",
          pathParams: { repositoryId: id, modelId },
          query,
        }),
      ),
  );

  server.registerTool(
    "list_model_versions",
    {
      description: "List versions for a model",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        ...pagination,
      },
    },
    async ({ repositoryId: id, modelId, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/versions",
          pathParams: { repositoryId: id, modelId },
          query,
        }),
      ),
  );

  server.registerTool(
    "get_model_version",
    {
      description: "Get a specific model version",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
        versionNumber,
        fields: pagination.fields,
        projection: pagination.projection,
      },
    },
    async ({ repositoryId: id, modelId, versionNumber: version, ...query }) =>
      runTool(() =>
        client.request({
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/versions/{versionNumber}",
          pathParams: {
            repositoryId: id,
            modelId,
            versionNumber: version,
          },
          query,
        }),
      ),
  );
}

export function registerModelWriteTools(
  server: McpServer,
  client: TwoC8Client,
): void {
  server.registerTool(
    "create_model",
    {
      description: "Create a model in a repository",
      inputSchema: {
        repositoryId,
        permissionGroup: permissionGroupHeader,
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, permissionGroup, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/models",
          pathParams: { repositoryId: id },
          headers: { "2c8-Permission-Group": permissionGroup },
          body,
        }),
      ),
  );

  server.registerTool(
    "update_model",
    {
      description: "Partially update a model",
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
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}",
          pathParams: { repositoryId: id, modelId },
          body,
        }),
      ),
  );

  server.registerTool(
    "delete_model",
    {
      description: "Delete a model",
      inputSchema: {
        repositoryId,
        modelId: uuid.describe("Model UUID"),
      },
    },
    async ({ repositoryId: id, modelId }) =>
      runTool(() =>
        client.request({
          method: "DELETE",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}",
          pathParams: { repositoryId: id, modelId },
        }),
      ),
  );

  server.registerTool(
    "create_draft_model",
    {
      description: "Create a draft model in the draft repository",
      inputSchema: {
        permissionGroup: permissionGroupHeader,
        body: jsonBody,
      },
    },
    async ({ permissionGroup, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/draft/models",
          headers: { "2c8-Permission-Group": permissionGroup },
          body,
        }),
      ),
  );

  server.registerTool(
    "accept_draft_model",
    {
      description:
        "Accept a draft model into a target repository and archive the source draft",
      inputSchema: {
        repositoryId: z
          .string()
          .min(1)
          .describe("Source repository UUID or draft alias"),
        modelId: uuid.describe("Draft model UUID"),
        permissionGroup: permissionGroupHeader,
        body: jsonBody,
      },
    },
    async ({ repositoryId: id, modelId, permissionGroup, body }) =>
      runTool(() =>
        client.request({
          method: "POST",
          path: "/api/v1/repositories/{repositoryId}/models/{modelId}/versions/accept",
          pathParams: { repositoryId: id, modelId },
          headers: { "2c8-Permission-Group": permissionGroup },
          body,
        }),
      ),
  );
}
