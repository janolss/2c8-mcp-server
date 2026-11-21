import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";

export function registerMethodologyPrompts(server: McpServer): void {
  server.registerPrompt(
    "consume_process",
    {
      description:
        "Workflow to understand an existing 2c8 process model (flow, roles, documents, breakdowns).",
      argsSchema: {
        repositoryId: z.string(),
        modelId: z.string().optional(),
        titleQuery: z.string().optional(),
      },
    },
    ({ repositoryId, modelId, titleQuery }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Follow this order strictly:",
              "1) get_methodology topic=process (optional context)",
              modelId
                ? `2) describe_process for repositoryId=${repositoryId} modelId=${modelId}`
                : `2) find_models for repositoryId=${repositoryId}${titleQuery ? ` query=${titleQuery}` : ""} then describe_process on the chosen modelId`,
              "3) Use summaryText / activities from describe_process as the primary answer",
              "4) Only if needed: get_breakdowns, get_process_flow, resolve_symbols",
              "5) Answer in Swedish: purpose, steps with responsible + systems, inputs/outputs, open questions.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "text_to_process_model",
    {
      description:
        "Workflow for text-to-model / talk-to-model creating a process in 2c8.",
      argsSchema: {
        repositoryId: z.string(),
        languageId: z.string(),
        processDescription: z.string(),
      },
    },
    ({ repositoryId, languageId, processDescription }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Create/update a 2c8 process from the description below.",
              "Order:",
              "1) get_methodology (process, activity, naming, reuse-first) + list_allowed_types",
              "2) propose_model_from_text — chain BO↔activity↔vägval, branches Ja/Nej. Prefixed: Vägval: … / Ja: … / Nej: …",
              "3) Review BOs: value/artefacts, NOT status echoes. Rewrite failing namingChecks.",
              "4) ANY choice/gateway: call resolve_branching_object_type — exclusive → objectType \"or\" (Regel Eller). NEVER create gateway or join.",
              "5) search_symbols objectType=or (vägval/decision aliases). Titles are questions, not 'vägval'.",
              "6) validate_against_methodology; fix titles if needed",
              "7) apply_model_proposal (chain nodes with objectType or)",
              "8) describe_process — expect decisions[]",
              "9) Gaps: create_canvas_edge(label=Ja|Nej) / set_activity_performer",
              "",
              `repositoryId=${repositoryId}`,
              `languageId=${languageId}`,
              "",
              "Description:",
              processDescription,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "describe_role_onboarding",
    {
      description:
        "Workflow: which processes/activities a role needs (e.g. new Däckmontör) plus onboarding checklist content.",
      argsSchema: {
        repositoryId: z.string(),
        roleTitle: z.string(),
      },
    },
    ({ repositoryId, roleTitle }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Describe onboarding / required processes for role "${roleTitle}".`,
              "Order:",
              `1) describe_role_introduction repositoryId=${repositoryId} titleQuery=${roleTitle}`,
              "2) Present layers separately: operationalCompetence (RACI) vs formalIntroduction (HR CONTROLS) vs supportContext (hints only)",
              "3) get_document_content on formalIntroduction.controllingDocuments (search_documents if id missing)",
              "4) Answer in Swedish: role-specific process skills vs formal HR introduction checklist.",
              "Do NOT invent role→checklist CONTROLS or RACI ownership — keep sources labeled as returned.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "create_process_map_overview",
    {
      description:
        "Workflow: build a process map / lifecycle overview (process chevrons + BO + breakdowns), not an activity detail model.",
      argsSchema: {
        repositoryId: z.string(),
        languageId: z.string(),
        title: z.string(),
        description: z
          .string()
          .optional()
          .describe("Optional narrative of how processes connect"),
      },
    },
    ({ repositoryId, languageId, title, description }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Create process map / overview titled "${title}".`,
              "Order:",
              "1) get_methodology topic=process-map and topic=breakdowns",
              "2) search_symbols for each process (objectType=process) — reuse UUIDs; do not create duplicate process symbols",
              "3) Prefer propose_process_map_from_models when you have detail model IDs — require shared BO (prev output = next input)",
              "4) validate_process_map_bridges on the chain before create_process_map",
              "5) create_process_map with chain (businessObject ↔ process), optional sideLoops, detailModelId per process",
              "6) describe_process_map to verify narrative, side loops and breakdowns",
              "Overview BO between processes MUST exist as output in previous detail and input in next detail (same symbol).",
              "Do NOT place activities on the overview canvas. Never stack symbols on the same coordinates.",
              "",
              `repositoryId=${repositoryId}`,
              `languageId=${languageId}`,
              description ? `Context:\n${description}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "document_to_process_model",
    {
      description:
        "Workflow for document-to-model extraction into a 2c8 process.",
      argsSchema: {
        repositoryId: z.string(),
        languageId: z.string(),
        documentText: z.string(),
        sourceUrl: z.string().optional(),
      },
    },
    ({ repositoryId, languageId, documentText, sourceUrl }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Extract a process model from the document text.",
              "Order:",
              "1) get_methodology (process, document-links, reuse-first)",
              "2) propose_model_from_document",
              "3) Present the proposal; rewrite business objects that are status echoes of activities into value/artefact titles",
              "4) search_symbols + validate_against_methodology (BOs: pass previousActivityTitle)",
              "5) apply_model_proposal when approved",
              "6) link_document for referenced documents where possible",
              "",
              `repositoryId=${repositoryId}`,
              `languageId=${languageId}`,
              sourceUrl ? `sourceUrl=${sourceUrl}` : "",
              "",
              "Document text:",
              documentText,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        },
      ],
    }),
  );
}
