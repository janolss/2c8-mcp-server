import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TwoC8Client } from "../client/twoc8-client.js";
import { registerCanvasReadTools, registerCanvasWriteTools } from "./canvas.js";
import {
  registerDescriptionReadTools,
  registerDescriptionWriteTools,
} from "./descriptions.js";
import { registerDirectoryTools } from "./directories.js";
import { registerMetaTools } from "./meta.js";
import { registerModelReadTools, registerModelWriteTools } from "./models.js";
import { registerQueryTools } from "./queries.js";
import { registerRelationTools } from "./relations.js";
import { registerRepositoryTools } from "./repositories.js";
import { registerSymbolReadTools, registerSymbolWriteTools } from "./symbols.js";

export function registerAllTools(
  server: McpServer,
  client: TwoC8Client,
  allowWrites: boolean,
): void {
  registerMetaTools(server, client);
  registerRepositoryTools(server, client);
  registerModelReadTools(server, client);
  registerSymbolReadTools(server, client);
  registerCanvasReadTools(server, client);
  registerDescriptionReadTools(server, client);
  registerRelationTools(server, client);
  registerQueryTools(server, client);
  registerDirectoryTools(server, client);

  if (allowWrites) {
    registerModelWriteTools(server, client);
    registerSymbolWriteTools(server, client);
    registerCanvasWriteTools(server, client);
    registerDescriptionWriteTools(server, client);
  }
}
