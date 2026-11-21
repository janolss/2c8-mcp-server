import type { TwoC8Client } from "../api/twoc8-client.js";
import type { WriteMode } from "../config.js";
import type { MethodologyPack } from "../methodology/loader.js";
import {
  extractQuickdrawDistance,
  labelPlacementForObjectType,
  loadRepoConfiguration,
  outsideLabelAwayFromEdge,
  resolveSymbolSize,
  validateProposedSymbol,
  type OutsideLabelSide,
  type QuickdrawDistance,
  type SymbolSizeSpec,
} from "../methodology/rules-engine.js";
import {
  normalizeProposal,
  type ModelProposal,
} from "./proposals.js";
import { ProcessReader } from "./process-reader.js";

const DEFAULT_WIDTH = 75;
const DEFAULT_HEIGHT = 50;
const LABEL_OUTSIDE_GAP = 3;
const LABEL_LINE_HEIGHT = 14;
const LABEL_CHAR_WIDTH = 5.5;
/** Compact outside labels (matches typical 2c8 double-click wrap width). */
const LABEL_OUTSIDE_MAX_WIDTH = 60;
const Y_BASE = 120;
const Y_BO = 135;
const Y_ACTIVITY = 119;
/** Gateway/decision diamond — centered on activity midline (30×30). */
const Y_GATEWAY = 129;
/** Vertical offset for side branches off a gateway. */
const BRANCH_Y_OFFSET = 160;
/** Shared vertical midline for FLOW spine (BO + process/activity). */
const SPINE_MID_Y = 178;
/**
 * Inset on process LEFT (incoming) only — matches Lättkrängt (~15–20% of width).
 * Outgoing RIGHT uses the AABB edge (no inset).
 */
const PROCESS_EDGE_INSET = 0.2;
/** Extra stub when routing around a process (side loops / reverse direction). */
const PROCESS_ROUTE_STUB = 24;

/** 2c8 soft line-break (UI often shows this as "¬"). */
const SOFT_HYPHEN = "\u00AD";
const SOFT_BREAK_RE = /[\u00AC\u00AD]/g;

function stripSoftBreaks(title: string): string {
  return title.replace(SOFT_BREAK_RE, "");
}

/** Map UI "¬" to soft hyphen used in symbol rawTitle. */
function normalizeSoftBreaks(title: string): string {
  return title.replace(/\u00AC/g, SOFT_HYPHEN);
}

/**
 * Insert soft hyphens in long Swedish compounds so outside labels wrap
 * (e.g. Personal­ansvarig, Service­tekniker). Preserves existing breaks.
 */
function applySoftBreaks(title: string): string {
  const normalized = normalizeSoftBreaks(title.trim());
  // Already has explicit break points from proposal/UI
  if (/[\u00AC\u00AD]/.test(normalized)) {
    return normalized;
  }
  // Prefer breaking before these suffixes when the stem is long enough
  const suffixes = [
    "ansvarig",
    "tekniker",
    "liggare",
    "medarbetare",
    "chef",
    "handläggare",
    "koordinator",
    "specialist",
  ];
  return normalized
    .split(/(\s+)/)
    .map((part) => {
      if (/^\s+$/.test(part) || part.length < 12) {
        return part;
      }
      const lower = part.toLowerCase();
      for (const suf of suffixes) {
        if (
          lower.endsWith(suf) &&
          lower.length - suf.length >= 4 &&
          lower !== suf
        ) {
          const cut = part.length - suf.length;
          return `${part.slice(0, cut)}${SOFT_HYPHEN}${part.slice(cut)}`;
        }
      }
      // Mid-word break for very long unbroken tokens (keep both sides readable)
      if (part.length >= 16) {
        const cut = Math.floor(part.length / 2);
        return `${part.slice(0, cut)}${SOFT_HYPHEN}${part.slice(cut)}`;
      }
      return part;
    })
    .join("");
}

/**
 * Map methodology / proposal types to API create payloads.
 * Models use UPPER_SNAKE (PROCESS_MODEL); most symbols accept lower/upper,
 * but businessobject must be BUSINESS_OBJECT.
 */
/**
 * Map methodology/agent object types to 2c8 create API types.
 * Vägval (Regel Eller/Och) are both API objectType "decision";
 * exclusive vs parallel is selected via alternativeSymbol OR|AND.
 */
function toApiObjectType(objectType: string): string {
  const key = objectType.trim().toLowerCase().replace(/[_\s]/g, "");
  const map: Record<string, string> = {
    businessobject: "BUSINESS_OBJECT",
    activity: "activity",
    role: "role",
    process: "process",
    application: "application",
    coredocument: "core_document",
    document: "core_document",
    position: "position",
    organization: "organization",
    organisation: "organization",
    // Exclusive vägval → DECISION (alternativeSymbol OR, API default)
    gateway: "decision",
    decision: "decision",
    vägval: "decision",
    vagval: "decision",
    regel: "decision",
    eller: "decision",
    or: "decision",
    xor: "decision",
    beslut: "decision",
    // Parallel Regel (Och) → same DECISION type, alternativeSymbol AND
    and: "decision",
    och: "decision",
    parallel: "decision",
  };
  // Join / Förbinda is forbidden in this MCP
  if (
    key === "join" ||
    key.includes("forbind") ||
    key.includes("förbind")
  ) {
    throw new Error(
      'objectType join/förbinda is forbidden. For vägval use objectType "or"/"decision" (Regel Eller). Call resolve_branching_object_type.',
    );
  }
  if (map[key]) return map[key];
  if (objectType.includes("_")) return objectType.toLowerCase();
  return objectType.toLowerCase();
}

/** Parallel Regel (Och) needs alternativeSymbol AND on DECISION create. */
function alternativeSymbolFor(objectType: string): "AND" | undefined {
  const key = objectType.trim().toLowerCase().replace(/[_\s]/g, "");
  if (key === "and" || key === "och" || key === "parallel" || key === "parallell") {
    return "AND";
  }
  return undefined;
}

/** Map methodology modelType hints to API model type ids (UPPER_SNAKE). */
function toApiModelType(modelType: string | undefined): string {
  const key = (modelType ?? "process").trim().toLowerCase().replace(/[_\s-]/g, "");
  const map: Record<string, string> = {
    process: "PROCESS_MODEL",
    processmodel: "PROCESS_MODEL",
    swimlane: "SWIMLANE_MODEL",
    swimlanemodel: "SWIMLANE_MODEL",
    general: "GENERAL_MODEL",
    generalmodel: "GENERAL_MODEL",
  };
  return map[key] ?? (modelType?.includes("_") ? modelType.toUpperCase() : "PROCESS_MODEL");
}

export class ProcessWriter {
  private readonly reader: ProcessReader;
  private readonly configCache = new Map<string, unknown | null>();

  constructor(
    private readonly client: TwoC8Client,
    private readonly pack: MethodologyPack,
    private readonly writeMode: WriteMode,
  ) {
    this.reader = new ProcessReader(client);
  }

  private async getRepoConfig(repositoryId: string): Promise<unknown | null> {
    if (this.configCache.has(repositoryId)) {
      return this.configCache.get(repositoryId) ?? null;
    }
    const config = await loadRepoConfiguration(this.client, repositoryId);
    this.configCache.set(repositoryId, config);
    return config;
  }

  private sizeFor(
    repositoryConfig: unknown | null,
    objectType: string,
  ): SymbolSizeSpec {
    return resolveSymbolSize(objectType, repositoryConfig);
  }

  private layoutGaps(repositoryConfig: unknown | null): {
    distance: QuickdrawDistance;
  } {
    const distance =
      extractQuickdrawDistance(repositoryConfig) ?? {
        top: 30,
        left: 40,
        bottom: 30,
        right: 40,
      };
    return { distance };
  }

  /**
   * Size label box so long titles wrap to ~2+ lines (like UI double-click).
   * Soft breaks ("¬" / U+00AD) are preferred wrap points, same as in 2c8.
   */
  private measureOutsideLabel(title: string): { width: number; height: number } {
    const raw = applySoftBreaks(title);
    // Soft hyphen and whitespace are break opportunities; ¬ already normalized
    const words = raw
      .split(/[\s\u00AD]+/)
      .map((w) => w.replace(SOFT_BREAK_RE, ""))
      .filter(Boolean);
    if (words.length === 0) {
      return { width: 40, height: LABEL_LINE_HEIGHT };
    }
    const maxWidth = LABEL_OUTSIDE_MAX_WIDTH;
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length * LABEL_CHAR_WIDTH <= maxWidth) {
        current = candidate;
      } else {
        if (current) {
          lines.push(current);
        }
        current = word;
      }
    }
    if (current) {
      lines.push(current);
    }
    const longest = Math.max(...lines.map((l) => l.length), 4);
    const width = Math.max(
      40,
      Math.min(maxWidth, Math.ceil(longest * LABEL_CHAR_WIDTH)),
    );
    const height = Math.max(LABEL_LINE_HEIGHT, lines.length * LABEL_LINE_HEIGHT);
    return { width, height };
  }

  private labelBounds(args: {
    objectType: string;
    title: string;
    x: number;
    y: number;
    width: number;
    height: number;
    /** Override outside side (e.g. away from vertical edge). */
    outsideLabelSide?: OutsideLabelSide;
  }): {
    centerLabel: boolean;
    label: { x: number; y: number; width: number; height: number };
  } {
    const size = { width: args.width, height: args.height };
    const base = labelPlacementForObjectType(args.objectType, size);
    if (base === "inside") {
      const pad = 2;
      return {
        centerLabel: false,
        label: {
          x: args.x + pad,
          y: args.y + pad,
          width: Math.max(20, args.width - pad * 2),
          height: Math.max(16, args.height - pad * 2),
        },
      };
    }

    const side: OutsideLabelSide = args.outsideLabelSide ?? base;
    const { width: labelWidth, height: labelHeight } = this.measureOutsideLabel(
      args.title,
    );
    const gap = LABEL_OUTSIDE_GAP;

    if (side === "above") {
      return {
        centerLabel: false,
        label: {
          x: args.x + Math.floor((args.width - labelWidth) / 2),
          y: args.y - gap - labelHeight,
          width: labelWidth,
          height: labelHeight,
        },
      };
    }
    if (side === "left") {
      return {
        centerLabel: false,
        label: {
          x: args.x - gap - labelWidth,
          y: args.y + Math.floor((args.height - labelHeight) / 2),
          width: labelWidth,
          height: labelHeight,
        },
      };
    }
    if (side === "right") {
      return {
        centerLabel: false,
        label: {
          x: args.x + args.width + gap,
          y: args.y + Math.floor((args.height - labelHeight) / 2),
          width: labelWidth,
          height: labelHeight,
        },
      };
    }
    // below (default for small icons)
    return {
      centerLabel: false,
      label: {
        x: args.x + Math.floor((args.width - labelWidth) / 2),
        y: args.y + args.height + gap,
        width: labelWidth,
        height: labelHeight,
      },
    };
  }

  async createProcessModel(args: {
    repositoryId: string;
    title: string;
    languageId: string;
    modelType?: string;
    permissionGroup?: string;
    owner?: string;
    group?: string;
    body?: Record<string, unknown>;
  }) {
    const modelType = toApiModelType(args.modelType);
    const body = {
      modelType,
      titles: {
        [args.languageId]: { title: args.title },
      },
      ...(args.owner ? { owner: args.owner } : {}),
      ...(args.group ? { group: args.group } : {}),
      ...args.body,
    };

    const headers = args.permissionGroup
      ? { "2c8-Permission-Group": args.permissionGroup }
      : undefined;

    if (this.writeMode === "draft") {
      const created = await this.client.request({
        method: "POST",
        path: "/api/v1/repositories/draft/models",
        headers,
        body,
      });
      return {
        data: created,
        writeMode: "draft",
        methodologyNotes: [
          "Created as draft model. Use accept_draft_model when ready.",
        ],
        nextSuggestedTools: ["add_process_step", "accept_draft_model"],
      };
    }

    const created = await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/models",
      pathParams: { repositoryId: args.repositoryId },
      headers,
      body,
    });
    return {
      data: created,
      writeMode: "direct",
      nextSuggestedTools: ["add_process_step", "set_step_io"],
    };
  }

  /**
   * Permanently delete a model. Gated by TWO_C8_ALLOW_DELETES (tool registration).
   */
  async deleteModel(args: { repositoryId: string; modelId: string }) {
    await this.client.request({
      method: "DELETE",
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
    });
    return {
      data: {
        deleted: true,
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
      methodologyNotes: [
        "Model deleted via DELETE /repositories/{repositoryId}/models/{modelId}. This is irreversible.",
      ],
      nextSuggestedTools: ["find_models", "list_repositories"],
    };
  }

  async addProcessStep(args: {
    repositoryId: string;
    modelId: string;
    title: string;
    languageId: string;
    objectType?: string;
    symbolId?: string;
    connectFromVertexId?: string;
    edgeType?: string;
    x?: number;
    y?: number;
    owner?: string;
    group?: string;
    forceCreate?: boolean;
  }) {
    const logicalType = args.objectType ?? "activity";
    const objectType = toApiObjectType(logicalType);
    const repoConfig = await this.getRepoConfig(args.repositoryId);
    const validation = validateProposedSymbol(this.pack, {
      objectType: logicalType,
      title: args.title,
      repoConfig,
    });
    const size = this.sizeFor(repoConfig, logicalType);
    const { distance } = this.layoutGaps(repoConfig);

    let reuseCandidates: unknown[] = [];
    let symbolId = args.symbolId;

    if (!symbolId && !args.forceCreate) {
      const search = await this.reader.searchSymbols({
        repositoryId: args.repositoryId,
        query: args.title,
        objectType,
        maxResults: "20",
      });
      reuseCandidates = (search.symbols as unknown[]) ?? [];
      const exact = (
        search.symbols as Array<{ uuid?: string; title?: string }>
      ).find(
        (s) =>
          (s.title ?? "").trim().toLowerCase() === args.title.trim().toLowerCase(),
      );
      if (exact?.uuid) {
        symbolId = exact.uuid;
      }
    }

    if (!symbolId) {
      const alt = alternativeSymbolFor(logicalType);
      const symbol = (await this.client.request({
        method: "POST",
        path: "/api/v1/repositories/{repositoryId}/symbols",
        pathParams: { repositoryId: args.repositoryId },
        body: {
          objectType,
          ...(alt ? { alternativeSymbol: alt } : {}),
          titles: { [args.languageId]: { title: args.title } },
          ...(args.owner ? { owner: args.owner } : {}),
          ...(args.group ? { group: args.group } : {}),
        },
      })) as { uuid?: string };
      symbolId = symbol.uuid;
    }

    if (!symbolId) {
      throw new Error("Failed to resolve symbolId for process step");
    }

    const canvas = (await this.client.request({
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
    })) as {
      vertices?: Array<{
        uuid?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }>;
    };

    const gapX = Math.max(distance.right, distance.left, 40);
    let x = args.x;
    let y = args.y;
    if (x === undefined || y === undefined) {
      const prev = args.connectFromVertexId
        ? (canvas.vertices ?? []).find((v) => v.uuid === args.connectFromVertexId)
        : undefined;
      if (prev && prev.x !== undefined && prev.width !== undefined) {
        x = x ?? Math.round(prev.x + prev.width + gapX);
        const prevMid =
          (prev.y ?? SPINE_MID_Y) + Math.floor((prev.height ?? size.height) / 2);
        y = y ?? Math.round(prevMid - size.height / 2);
      } else {
        x = x ?? 50;
        y = y ?? Math.round(SPINE_MID_Y - size.height / 2);
      }
    }

    const vertex = await this.placeVertex({
      repositoryId: args.repositoryId,
      modelId: args.modelId,
      symbolId,
      languageId: args.languageId,
      title: args.title,
      objectType: logicalType,
      x,
      y,
      width: size.width,
      height: size.height,
    });

    let edge: unknown = null;
    const vertexId = vertex.uuid;
    if (args.connectFromVertexId && vertexId) {
      edge = (
        await this.createCanvasEdge({
          repositoryId: args.repositoryId,
          modelId: args.modelId,
          fromVertexId: args.connectFromVertexId,
          toVertexId: vertexId,
          edgeType: args.edgeType ?? "flow",
          languageId: args.languageId,
        })
      ).data;
    }

    return {
      data: { symbolId, vertex, edge },
      methodologyNotes: [
        ...validation.methodologyNotes,
        "Placement avoids overlapping existing canvas vertices (auto-nudge if needed).",
      ],
      namingCheck: validation.namingCheck,
      reuseCandidates,
      configViolations: validation.configViolations,
      nextSuggestedTools:
        objectType === "activity"
          ? ["set_activity_performer", "set_step_io", "link_document"]
          : ["set_step_io", "link_document"],
    };
  }

  async reuseSymbol(args: {
    repositoryId: string;
    modelId: string;
    symbolId: string;
    languageId: string;
    title?: string;
    objectType?: string;
    x?: number;
    y?: number;
  }) {
    const repoConfig = await this.getRepoConfig(args.repositoryId);
    const logicalType = args.objectType ?? "activity";
    const size = this.sizeFor(repoConfig, logicalType);
    const { distance } = this.layoutGaps(repoConfig);
    const canvas = (await this.client.request({
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
    })) as { vertices?: unknown[] };

    const count = canvas.vertices?.length ?? 0;
    const vertex = await this.placeVertex({
      repositoryId: args.repositoryId,
      modelId: args.modelId,
      symbolId: args.symbolId,
      languageId: args.languageId,
      title: args.title ?? "Symbol",
      objectType: logicalType,
      x: args.x ?? 80 + count * (size.width + distance.left),
      y: args.y ?? Y_BASE,
      width: size.width,
      height: size.height,
    });

    return {
      data: vertex,
      methodologyNotes: [
        "Reused existing symbol UUID — changes to the symbol propagate across models. Size from repository symbolsizes.",
        "Placement avoids overlapping existing canvas vertices (auto-nudge if needed).",
      ],
      nextSuggestedTools: ["set_activity_performer", "create_canvas_edge"],
    };
  }

  async createBreakdown(args: {
    repositoryId: string;
    modelId: string;
    body: Record<string, unknown>;
  }) {
    const created = await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/broken-down-from",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
      body: args.body,
    });
    return {
      data: created,
      methodologyNotes: [
        "Breakdown links this model as a detailing of a symbol or edge in another model.",
        "Preferred write body: { symbol: \"<overviewSymbolUuid>\" }. Prefer link_breakdown.",
      ],
      nextSuggestedTools: ["get_breakdowns", "get_process_flow"],
    };
  }

  /**
   * Link a detail model as breakdown of an overview symbol (process chevron).
   * POST body is { symbol: overviewSymbolId } on the detail model.
   */
  async linkBreakdown(args: {
    repositoryId: string;
    detailModelId: string;
    overviewSymbolId: string;
  }) {
    try {
      const created = await this.client.request({
        method: "POST",
        path: "/api/v1/repositories/{repositoryId}/models/{modelId}/broken-down-from",
        pathParams: {
          repositoryId: args.repositoryId,
          modelId: args.detailModelId,
        },
        body: { symbol: args.overviewSymbolId },
      });
      return {
        data: created,
        methodologyNotes: [
          "Breakdown: detail model elaborates the overview process symbol (reuse same UUID on the map).",
        ],
        nextSuggestedTools: ["get_breakdowns", "describe_process_map"],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Idempotent: same symbol→detail link already present
      if (/\b409\b/.test(msg) || /already exists/i.test(msg)) {
        return {
          data: {
            alreadyLinked: true,
            detailModelId: args.detailModelId,
            overviewSymbolId: args.overviewSymbolId,
          },
          methodologyNotes: [
            "Breakdown already existed for this symbol/detail pair — left as-is.",
          ],
          nextSuggestedTools: ["get_breakdowns", "describe_process_map"],
        };
      }
      throw err;
    }
  }

  /**
   * Create a process map / overview: BO ↔ process chevrons on FLOW,
   * optional side loops, optional breakdowns to detail models.
   */
  async createProcessMap(args: {
    repositoryId: string;
    languageId: string;
    title: string;
    chain: Array<{
      kind: "businessObject" | "process";
      title: string;
      symbolId?: string;
      detailModelId?: string;
    }>;
    sideLoops?: Array<{
      fromBoTitle: string;
      processTitle: string;
      symbolId?: string;
      detailModelId?: string;
      placement?: "below";
    }>;
    permissionGroup?: string;
    owner?: string;
    group?: string;
    modelId?: string;
  }) {
    const hasDetailLinks = args.chain.some(
      (n) => n.kind === "process" && n.detailModelId,
    );
    const bridgeValidation = hasDetailLinks
      ? await this.reader.validateProcessMapBoBridges({
          repositoryId: args.repositoryId,
          chain: args.chain,
        })
      : { ok: true, checks: [], errors: [] as string[] };
    if (!bridgeValidation.ok) {
      throw new Error(
        `create_process_map blocked — overview business objects must match detail I/O:\n` +
          bridgeValidation.errors.join("\n"),
      );
    }

    const repoConfig = await this.getRepoConfig(args.repositoryId);
    const { distance } = this.layoutGaps(repoConfig);
    const gapX = Math.max(distance.right, distance.left, 40);
    const gapY = Math.max(distance.bottom, 30);
    const rowGap = 140;
    const symbolCache = new Map<string, string>();
    const reserved: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];

    let modelId = args.modelId;
    const appending = Boolean(args.modelId);
    if (!modelId) {
      const created = await this.createProcessModel({
        repositoryId: args.repositoryId,
        title: args.title,
        languageId: args.languageId,
        modelType: "process",
        permissionGroup: args.permissionGroup,
        owner: args.owner,
        group: args.group,
      });
      modelId =
        (created.data as { uuid?: string })?.uuid ??
        (created.data as { model?: { uuid?: string } })?.model?.uuid;
      if (!modelId) {
        throw new Error(
          "create_process_map: could not resolve modelId; pass modelId explicitly.",
        );
      }
    }

    // Keep BO + process on one midline; when appending, start a new row below
    // existing content instead of colliding with the first spine.
    let spineMidY = SPINE_MID_Y;
    if (appending) {
      const canvas = (await this.client.request({
        path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
        pathParams: {
          repositoryId: args.repositoryId,
          modelId,
        },
      })) as {
        vertices?: Array<{
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        }>;
      };
      let maxBottom = 0;
      for (const v of canvas.vertices ?? []) {
        const bottom = (v.y ?? 0) + (v.height ?? 0);
        if (bottom > maxBottom) maxBottom = bottom;
      }
      if ((canvas.vertices?.length ?? 0) > 0) {
        spineMidY = Math.round(maxBottom + rowGap);
      }
    }

    const placed: Array<{
      title: string;
      kind: string;
      objectType: string;
      symbolId: string;
      vertexId: string;
      x: number;
      y: number;
      width: number;
      height: number;
      detailModelId?: string;
    }> = [];
    const breakdowns: unknown[] = [];

    let prev: {
      vertexId: string;
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;

    for (const node of args.chain) {
      const objectType =
        node.kind === "process" ? "process" : "businessObject";
      const size = this.sizeFor(repoConfig, objectType);
      const symbolId =
        node.symbolId ??
        (await this.resolveOrCreateSymbol({
          repositoryId: args.repositoryId,
          languageId: args.languageId,
          title: node.title,
          objectType,
          owner: args.owner,
          group: args.group,
          cache: symbolCache,
        }));

      const placeX: number = prev
        ? Math.round(prev.x + prev.width + gapX)
        : 50;
      const placeY: number = Math.round(spineMidY - size.height / 2);

      const vertex = await this.placeVertex({
        repositoryId: args.repositoryId,
        modelId,
        symbolId,
        languageId: args.languageId,
        title: node.title,
        objectType,
        x: placeX,
        y: placeY,
        width: size.width,
        height: size.height,
        reserved,
        spineAlign: true,
      });
      const vertexId = String(vertex.uuid);
      const usedX = vertex.x ?? placeX;
      const usedY = vertex.y ?? placeY;
      if (prev) {
        await this.createCanvasEdge({
          repositoryId: args.repositoryId,
          modelId,
          fromVertexId: prev.vertexId,
          toVertexId: vertexId,
          edgeType: "flow",
          languageId: args.languageId,
        });
      }

      if (node.kind === "process" && node.detailModelId) {
        const bd = await this.linkBreakdown({
          repositoryId: args.repositoryId,
          detailModelId: node.detailModelId,
          overviewSymbolId: symbolId,
        });
        breakdowns.push({
          detailModelId: node.detailModelId,
          overviewSymbolId: symbolId,
          result: bd.data,
        });
      }

      const entry = {
        title: node.title,
        kind: node.kind,
        objectType,
        symbolId,
        vertexId,
        x: usedX,
        y: usedY,
        width: size.width,
        height: size.height,
        detailModelId: node.detailModelId,
      };
      placed.push(entry);
      prev = {
        vertexId,
        x: usedX,
        y: usedY,
        width: size.width,
        height: size.height,
      };
    }

    let sideLoopIndex = 0;
    for (const loop of args.sideLoops ?? []) {
      const bo = placed.find(
        (p) =>
          p.kind === "businessObject" &&
          p.title.toLowerCase() === loop.fromBoTitle.trim().toLowerCase(),
      );
      if (!bo) {
        throw new Error(
          `create_process_map: sideLoop fromBoTitle '${loop.fromBoTitle}' not found on chain`,
        );
      }
      const size = this.sizeFor(repoConfig, "process");
      const symbolId =
        loop.symbolId ??
        (await this.resolveOrCreateSymbol({
          repositoryId: args.repositoryId,
          languageId: args.languageId,
          title: loop.processTitle,
          objectType: "process",
          owner: args.owner,
          group: args.group,
          cache: symbolCache,
        }));
      const x = Math.round(bo.x + Math.floor(bo.width / 2) - size.width / 2);
      const y = Math.round(
        bo.y + bo.height + gapY + sideLoopIndex * (size.height + gapY),
      );
      sideLoopIndex += 1;

      const vertex = await this.placeVertex({
        repositoryId: args.repositoryId,
        modelId,
        symbolId,
        languageId: args.languageId,
        title: loop.processTitle,
        objectType: "process",
        x,
        y,
        width: size.width,
        height: size.height,
        reserved,
      });
      const vertexId = String(vertex.uuid);
      const usedX = vertex.x ?? x;
      const usedY = vertex.y ?? y;

      // Side attachment under a state BO: one FLOW BO → process.
      // Do NOT add process → same BO (looks like a nonsense double link).
      // True employment-style loops that return to the state BO should be
      // modeled explicitly with a separate return path when needed.
      await this.createCanvasEdge({
        repositoryId: args.repositoryId,
        modelId,
        fromVertexId: bo.vertexId,
        toVertexId: vertexId,
        edgeType: "flow",
        languageId: args.languageId,
      });

      if (loop.detailModelId) {
        const bd = await this.linkBreakdown({
          repositoryId: args.repositoryId,
          detailModelId: loop.detailModelId,
          overviewSymbolId: symbolId,
        });
        breakdowns.push({
          detailModelId: loop.detailModelId,
          overviewSymbolId: symbolId,
          result: bd.data,
        });
      }

      placed.push({
        title: loop.processTitle,
        kind: "sideLoop",
        objectType: "process",
        symbolId,
        vertexId,
        x: usedX,
        y: usedY,
        width: size.width,
        height: size.height,
        detailModelId: loop.detailModelId,
      });
    }

    return {
      data: {
        modelId,
        placed,
        breakdowns,
        bridgeChecks: bridgeValidation.checks,
        chainLength: args.chain.length,
        sideLoopCount: args.sideLoops?.length ?? 0,
      },
      methodologyNotes: [
        "Process map: process chevrons + business objects on FLOW (not activities).",
        "Reuse process symbol UUIDs; breakdowns link detail models to those symbols.",
        "Overview BO between processes must be the same symbol as detail output→input handoff.",
        "Side loops are supporting processes under a state BO.",
        "Vertices are auto-nudged to avoid stacking on the same coordinates.",
      ],
      nextSuggestedTools: ["describe_process_map", "get_breakdowns"],
    };
  }

  /** Normalize edge type aliases to API UPPER_SNAKE values. */
  private toApiEdgeType(edgeType: string): string {
    const key = edgeType.trim().toLowerCase().replace(/[_\s-]/g, "");
    const map: Record<string, string> = {
      flow: "FLOW",
      raciresponsible: "RACI_RESPONSIBLE",
      responsible: "RACI_RESPONSIBLE",
      controls: "CONTROLS",
      control: "CONTROLS",
      isusedby: "IS_USED_BY",
      usedby: "IS_USED_BY",
      isfollowedby: "IS_FOLLOWED_BY",
      followedby: "IS_FOLLOWED_BY",
    };
    if (map[key]) return map[key];
    if (edgeType.includes("_")) return edgeType.toUpperCase();
    return edgeType.toUpperCase();
  }

  private boxCenter(b: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): { x: number; y: number } {
    const w = b.width ?? DEFAULT_WIDTH;
    const h = b.height ?? DEFAULT_HEIGHT;
    return {
      x: (b.x ?? 0) + Math.floor(w / 2),
      y: (b.y ?? 0) + Math.floor(h / 2),
    };
  }

  private isProcessObjectType(objectType?: string): boolean {
    const t = (objectType ?? "").toLowerCase().replace(/[\s_-]/g, "");
    return t === "process" || t === "processmodel";
  }

  private isActivityObjectType(objectType?: string): boolean {
    const t = (objectType ?? "").toLowerCase().replace(/[\s_-]/g, "");
    return t === "activity";
  }

  /** FLOW spine types that must use left-in / right-out (never top/bottom). */
  private isFlowLeftRightType(objectType?: string): boolean {
    return (
      this.isProcessObjectType(objectType) ||
      this.isActivityObjectType(objectType)
    );
  }

  private isFlowEdgeType(edgeType?: string): boolean {
    if (!edgeType) return false;
    const key = edgeType.trim().toLowerCase().replace(/[_\s-]/g, "");
    return key === "flow" || key === "sequence";
  }

  /**
   * Attachment point on the box border facing a target point (2c8 style).
   */
  private borderAttachment(
    box: { x?: number; y?: number; width?: number; height?: number },
    toward: { x: number; y: number },
  ): { x: number; y: number; side: "top" | "bottom" | "left" | "right" } {
    const x = box.x ?? 0;
    const y = box.y ?? 0;
    const w = box.width ?? DEFAULT_WIDTH;
    const h = box.height ?? DEFAULT_HEIGHT;
    const cx = x + Math.floor(w / 2);
    const cy = y + Math.floor(h / 2);
    const dx = toward.x - cx;
    const dy = toward.y - cy;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx >= 0) {
        return { x: x + w, y: cy, side: "right" };
      }
      return { x, y: cy, side: "left" };
    }
    if (dy >= 0) {
      return { x: cx, y: y + h, side: "bottom" };
    }
    return { x: cx, y, side: "top" };
  }

  /**
   * FLOW incoming attach on left. Process chevrons inset into body;
   * activities use the left AABB edge (no inset).
   */
  private flowLeftAttach(
    box: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      objectType?: string;
    },
  ): { x: number; y: number; side: "left" } {
    const x = box.x ?? 0;
    const y = box.y ?? 0;
    const w = box.width ?? DEFAULT_WIDTH;
    const h = box.height ?? DEFAULT_HEIGHT;
    const inset = this.isProcessObjectType(box.objectType)
      ? Math.floor(w * PROCESS_EDGE_INSET)
      : 0;
    return {
      x: x + inset,
      y: y + Math.floor(h / 2),
      side: "left",
    };
  }

  /** FLOW outgoing attach on right edge (no inset — matches MT). */
  private flowRightAttach(box: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  }): { x: number; y: number; side: "right" } {
    const x = box.x ?? 0;
    const y = box.y ?? 0;
    const w = box.width ?? DEFAULT_WIDTH;
    const h = box.height ?? DEFAULT_HEIGHT;
    return {
      x: x + w,
      y: y + Math.floor(h / 2),
      side: "right",
    };
  }

  /**
   * Orthogonal route that respects process left-in / right-out, with detours
   * when the peer is above/below (side loops) instead of attaching to top/bottom.
   */
  private routeOrthogonal(
    p0: { x: number; y: number; side: "top" | "bottom" | "left" | "right" },
    pN: { x: number; y: number; side: "top" | "bottom" | "left" | "right" },
    opts?: { approachFromLeftOf?: number; departRightOf?: number },
  ): Array<{ x: number; y: number }> {
    // Process left-in / right-out detours first — do not collapse to a straight
    // chord that would cross the chevron body when peer is left/above/below.
    if (pN.side === "left" && opts?.approachFromLeftOf !== undefined) {
      const clearX = opts.approachFromLeftOf - PROCESS_ROUTE_STUB;
      const pts: Array<{ x: number; y: number }> = [{ x: p0.x, y: p0.y }];
      if (p0.x !== clearX) {
        pts.push({ x: clearX, y: p0.y });
      }
      if (p0.y !== pN.y) {
        pts.push({ x: clearX, y: pN.y });
      }
      pts.push({ x: pN.x, y: pN.y });
      return pts;
    }

    // Leaving a process right when target is not further right on the same row
    if (p0.side === "right" && opts?.departRightOf !== undefined) {
      const stubX = opts.departRightOf + PROCESS_ROUTE_STUB;
      return [
        { x: p0.x, y: p0.y },
        { x: stubX, y: p0.y },
        { x: stubX, y: pN.y },
        { x: pN.x, y: pN.y },
      ];
    }

    if (p0.x === pN.x || p0.y === pN.y) {
      return [
        { x: p0.x, y: p0.y },
        { x: pN.x, y: pN.y },
      ];
    }

    if (p0.side === "left" || p0.side === "right") {
      const midX = Math.floor((p0.x + pN.x) / 2);
      return [
        { x: p0.x, y: p0.y },
        { x: midX, y: p0.y },
        { x: midX, y: pN.y },
        { x: pN.x, y: pN.y },
      ];
    }
    const midY = Math.floor((p0.y + pN.y) / 2);
    return [
      { x: p0.x, y: p0.y },
      { x: p0.x, y: midY },
      { x: pN.x, y: midY },
      { x: pN.x, y: pN.y },
    ];
  }

  /**
   * FLOW involving process/activity: leave on the RIGHT and enter on the LEFT
   * (never top/bottom on those types). Other symbols keep normal border
   * attachment. Edge `points` are an orthogonal polyline.
   */
  private orthogonalPointsFlowLeftRight(
    from: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      objectType?: string;
    },
    to: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      objectType?: string;
    },
  ): Array<{ x: number; y: number }> {
    const fromForced = this.isFlowLeftRightType(from.objectType);
    const toForced = this.isFlowLeftRightType(to.objectType);
    // When either end is process/activity, both use left-in / right-out so
    // BO↔activity and side branches stay off top/bottom of the activity.
    const forceBoth = fromForced || toForced;
    const fromCenter = this.boxCenter(from);
    const toCenter = this.boxCenter(to);

    const p0 = forceBoth
      ? this.flowRightAttach(from)
      : this.borderAttachment(from, toCenter);
    const pN = forceBoth
      ? this.flowLeftAttach(to)
      : this.borderAttachment(to, fromCenter);

    const opts: { approachFromLeftOf?: number; departRightOf?: number } = {};
    const sameRow = Math.abs(p0.y - pN.y) <= 8;
    if (forceBoth) {
      const targetLeft = to.x ?? 0;
      if (!sameRow || p0.x >= targetLeft - 2) {
        opts.approachFromLeftOf = targetLeft;
      }
      const sourceRight = (from.x ?? 0) + (from.width ?? DEFAULT_WIDTH);
      if (!sameRow || pN.x <= sourceRight + 2) {
        opts.departRightOf = sourceRight;
      }
    }

    return this.routeOrthogonal(p0, pN, opts);
  }

  /**
   * Orthogonal polyline with endpoints on symbol borders (not centers).
   * FLOW on process/activity: left-in / right-out (never top/bottom).
   * Non-FLOW (RACI/CONTROLS/IS_USED_BY): stacked symbols use top↔bottom.
   */
  private orthogonalPoints(
    from: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      objectType?: string;
    },
    to: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      objectType?: string;
    },
    edgeType?: string,
  ): Array<{ x: number; y: number }> {
    const isFlow = !edgeType || this.isFlowEdgeType(edgeType);
    if (
      isFlow &&
      (this.isFlowLeftRightType(from.objectType) ||
        this.isFlowLeftRightType(to.objectType))
    ) {
      return this.orthogonalPointsFlowLeftRight(from, to);
    }

    const fx = from.x ?? 0;
    const fy = from.y ?? 0;
    const fw = from.width ?? DEFAULT_WIDTH;
    const fh = from.height ?? DEFAULT_HEIGHT;
    const tx = to.x ?? 0;
    const ty = to.y ?? 0;
    const tw = to.width ?? DEFAULT_WIDTH;
    const th = to.height ?? DEFAULT_HEIGHT;
    const fromCenter = this.boxCenter(from);
    const toCenter = this.boxCenter(to);

    const fromBelow = fy >= ty + th - 2;
    const fromAbove = fy + fh <= ty + 2;

    let p0: { x: number; y: number; side: "top" | "bottom" | "left" | "right" };
    let pN: { x: number; y: number; side: "top" | "bottom" | "left" | "right" };

    if (fromBelow) {
      p0 = { x: fromCenter.x, y: fy, side: "top" };
      pN = { x: toCenter.x, y: ty + th, side: "bottom" };
    } else if (fromAbove) {
      p0 = { x: fromCenter.x, y: fy + fh, side: "bottom" };
      pN = { x: toCenter.x, y: ty, side: "top" };
    } else {
      p0 = this.borderAttachment(from, toCenter);
      pN = this.borderAttachment(to, fromCenter);
    }

    return this.routeOrthogonal(p0, pN);
  }

  /**
   * Bottom layout: primary role centered under activity; side satellites nest
   * tightly against the primary icon (not label width) with a slight diagonal
   * stagger — close to center, not under neighbouring FLOW I/O objects.
   */
  private layoutBottomSatellites(args: {
    activity: { x: number; y: number; width: number; height: number };
    roles: Array<{ title: string; width: number; height: number; packWidth: number }>;
    others: Array<{ title: string; width: number; height: number; packWidth: number }>;
    gap: number;
  }): Map<string, { x: number; y: number }> {
    const { activity, roles, others, gap } = args;
    // Clearance under activity; nest/stagger keep side symbols clustered
    const y = activity.y + activity.height + gap;
    const nestGap = 16;
    const staggerY = 14;
    const result = new Map<string, { x: number; y: number }>();
    const actCx = activity.x + Math.floor(activity.width / 2);

    const placeSideCluster = (
      center: { title: string; width: number; height: number },
      sideItems: Array<{ title: string; width: number; height: number }>,
    ): void => {
      const centerX = actCx - Math.floor(center.width / 2);
      result.set(center.title, { x: centerX, y });
      let leftEdge = centerX;
      let rightEdge = centerX + center.width;
      let placeRight = true;
      let ring = 0;
      for (const item of sideItems) {
        const itemY = y + staggerY + ring * Math.floor(staggerY / 2);
        if (placeRight) {
          const x = rightEdge + nestGap;
          result.set(item.title, { x, y: itemY });
          rightEdge = x + item.width;
        } else {
          const x = leftEdge - nestGap - item.width;
          result.set(item.title, { x, y: itemY });
          leftEdge = x;
        }
        placeRight = !placeRight;
        if (placeRight) ring += 1;
      }
    };

    const primary = roles[0];
    if (primary) {
      placeSideCluster(primary, [...roles.slice(1), ...others]);
      return result;
    }

    if (others.length === 0) {
      return result;
    }
    const first = others[0]!;
    placeSideCluster(first, others.slice(1));
    return result;
  }

  /**
   * Pack satellites along one side of an activity without overlap.
   */
  private packAroundActivity(args: {
    activity: { x: number; y: number; width: number; height: number };
    side: "top" | "bottom" | "left" | "right";
    items: Array<{ width: number; height: number }>;
    gap: number;
  }): Array<{ x: number; y: number }> {
    const { activity, side, items, gap } = args;
    if (items.length === 0) {
      return [];
    }
    if (side === "bottom" || side === "top") {
      const totalW =
        items.reduce((s, it) => s + it.width, 0) + gap * (items.length - 1);
      let x = activity.x + Math.floor(activity.width / 2) - Math.floor(totalW / 2);
      const maxH = Math.max(...items.map((it) => it.height));
      const y =
        side === "bottom"
          ? activity.y + activity.height + gap
          : activity.y - gap - maxH;
      return items.map((it) => {
        const pos = {
          x: Math.round(x),
          y:
            side === "bottom"
              ? Math.round(y)
              : Math.round(activity.y - gap - it.height),
        };
        x += it.width + gap;
        return pos;
      });
    }
    // left / right
    const totalH =
      items.reduce((s, it) => s + it.height, 0) + gap * (items.length - 1);
    let y = activity.y + Math.floor(activity.height / 2) - Math.floor(totalH / 2);
    const maxW = Math.max(...items.map((it) => it.width));
    return items.map((it) => {
      const pos = {
        x:
          side === "right"
            ? Math.round(activity.x + activity.width + gap)
            : Math.round(activity.x - gap - it.width),
        y: Math.round(y),
      };
      void maxW;
      y += it.height + gap;
      return pos;
    });
  }

  async createCanvasEdge(args: {
    repositoryId: string;
    modelId: string;
    fromVertexId: string;
    toVertexId: string;
    edgeType: string;
    languageId: string;
    /** Edge label text (e.g. Ja/Nej on gateway branches). */
    label?: string;
  }) {
    const edgeType = this.toApiEdgeType(args.edgeType);
    const canvas = (await this.client.request({
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
    })) as {
      vertices?: Array<{
        uuid?: string;
        x?: number;
        y?: number;
        width?: number;
        height?: number;
        objectType?: string;
      }>;
    };
    const from = (canvas.vertices ?? []).find((v) => v.uuid === args.fromVertexId);
    const to = (canvas.vertices ?? []).find((v) => v.uuid === args.toVertexId);
    const points = this.orthogonalPoints(from ?? {}, to ?? {}, edgeType);
    const midX = Math.floor(((points[0]?.x ?? 0) + (points[points.length - 1]?.x ?? 0)) / 2);
    const midY = Math.floor(((points[0]?.y ?? 0) + (points[points.length - 1]?.y ?? 0)) / 2) - 10;
    const labelText = (args.label ?? "").trim();
    const labelWidth = Math.max(40, Math.min(120, Math.ceil(labelText.length * 6) + 12));

    const edge = await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/edges",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
      body: {
        fromVertex: args.fromVertexId,
        toVertex: args.toVertexId,
        edgeType,
        points,
        labels: {
          [args.languageId]: {
            title: labelText,
            rawTitle: labelText,
            x: midX - Math.floor(labelWidth / 2),
            y: midY,
            width: labelWidth,
            height: 20,
          },
        },
      },
    });
    return {
      data: edge,
      methodologyNotes: [
        `Created canvas edge type=${edgeType}${labelText ? ` label="${labelText}"` : ""}. Common types: FLOW, RACI_RESPONSIBLE, CONTROLS, IS_USED_BY, IS_FOLLOWED_BY.`,
        ...(this.isFlowEdgeType(edgeType)
          ? [
              "FLOW on process/activity: enter left edge, leave right edge (never top/bottom).",
            ]
          : []),
      ],
      nextSuggestedTools: ["get_process_flow", "describe_process"],
    };
  }

  async createRepository(args: {
    name: string;
    languages?: Array<{ name: string; locale: string; default?: boolean }>;
    template?: boolean;
    owner?: string;
    directory?: string;
    colorScheme?: string;
    body?: Record<string, unknown>;
  }) {
    const languages =
      args.languages ??
      [
        {
          name: "Svenska",
          locale: "sv_SE",
          default: true,
        },
      ];
    const created = await this.client.request({
      method: "POST",
      path: "/api/v1/repositories",
      body: {
        name: args.name,
        template: args.template ?? false,
        languages,
        ...(args.owner ? { owner: args.owner } : {}),
        ...(args.directory ? { directory: args.directory } : {}),
        ...(args.colorScheme ? { colorScheme: args.colorScheme } : {}),
        ...args.body,
      },
    });
    return {
      data: created,
      methodologyNotes: [
        "Repository created. List languages via list_languages before writing titles.",
      ],
      nextSuggestedTools: [
        "list_languages",
        "list_allowed_types",
        "propose_model_from_text",
        "apply_model_proposal",
      ],
    };
  }

  /**
   * Resolve or create a symbol by title (reuse-first), return symbolId.
   */
  private async resolveOrCreateSymbol(args: {
    repositoryId: string;
    languageId: string;
    title: string;
    objectType: string;
    owner?: string;
    group?: string;
    cache: Map<string, string>;
  }): Promise<string> {
    const apiType = toApiObjectType(args.objectType);
    const plainTitle = stripSoftBreaks(args.title).trim();
    const rawTitle = applySoftBreaks(args.title);
    const cacheKey = `${apiType}::${plainTitle.toLowerCase()}`;
    const cached = args.cache.get(cacheKey);
    if (cached) return cached;

    const search = await this.reader.searchSymbols({
      repositoryId: args.repositoryId,
      query: plainTitle,
      objectType: apiType,
      maxResults: "20",
    });
    const exact = (
      search.symbols as Array<{ uuid?: string; title?: string }>
    ).find(
      (s) =>
        stripSoftBreaks(s.title ?? "").trim().toLowerCase() ===
        plainTitle.toLowerCase(),
    );
    if (exact?.uuid) {
      args.cache.set(cacheKey, exact.uuid);
      return exact.uuid;
    }

    const alt = alternativeSymbolFor(args.objectType);
    const symbol = (await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/symbols",
      pathParams: { repositoryId: args.repositoryId },
      body: {
        objectType: apiType,
        ...(alt ? { alternativeSymbol: alt } : {}),
        titles: {
          [args.languageId]: {
            title: plainTitle,
            // Soft hyphen (UI "¬") so 2c8 wraps compound labels compactly
            rawTitle,
          },
        },
        ...(args.owner ? { owner: args.owner } : {}),
        ...(args.group ? { group: args.group } : {}),
      },
    })) as { uuid?: string };
    if (!symbol.uuid) {
      throw new Error(`Failed to create symbol '${plainTitle}' (${apiType})`);
    }
    args.cache.set(cacheKey, symbol.uuid);
    return symbol.uuid;
  }

  private boxesOverlap(
    a: { x: number; y: number; width: number; height: number },
    b: { x: number; y: number; width: number; height: number },
    pad = 6,
  ): boolean {
    return !(
      a.x + a.width + pad <= b.x ||
      b.x + b.width + pad <= a.x ||
      a.y + a.height + pad <= b.y ||
      b.y + b.height + pad <= a.y
    );
  }

  /**
   * Nudge right, then down, until the box does not overlap occupied placements.
   * Never leave two symbols on the exact same coordinates.
   */
  private findFreePlacement(
    occupied: Array<{ x: number; y: number; width: number; height: number }>,
    x: number,
    y: number,
    width: number,
    height: number,
    stepX = 24,
    stepY = 24,
  ): { x: number; y: number; shifted: boolean } {
    const collides = (cx: number, cy: number) =>
      occupied.some((o) =>
        this.boxesOverlap({ x: cx, y: cy, width, height }, o),
      );
    let cx = Math.round(x);
    let cy = Math.round(y);
    if (!collides(cx, cy)) {
      return { x: cx, y: cy, shifted: false };
    }
    for (let i = 1; i <= 100; i++) {
      const rightX = Math.round(x) + i * stepX;
      if (!collides(rightX, Math.round(y))) {
        return { x: rightX, y: Math.round(y), shifted: true };
      }
      const downY = Math.round(y) + i * stepY;
      if (!collides(Math.round(x), downY)) {
        return { x: Math.round(x), y: downY, shifted: true };
      }
      if (!collides(rightX, downY)) {
        return { x: rightX, y: downY, shifted: true };
      }
    }
    return {
      x: Math.round(x) + 100 * stepX,
      y: Math.round(y) + stepY,
      shifted: true,
    };
  }

  /**
   * FLOW spine placement: only nudge horizontally so BO and process stay on
   * the same vertical midline (never shift Y independently).
   */
  private findFreePlacementOnSpine(
    occupied: Array<{ x: number; y: number; width: number; height: number }>,
    x: number,
    y: number,
    width: number,
    height: number,
    stepX = 24,
  ): { x: number; y: number; shifted: boolean } {
    const collides = (cx: number) =>
      occupied.some((o) =>
        this.boxesOverlap(
          { x: cx, y: Math.round(y), width, height },
          o,
        ),
      );
    const cy = Math.round(y);
    let cx = Math.round(x);
    if (!collides(cx)) {
      return { x: cx, y: cy, shifted: false };
    }
    for (let i = 1; i <= 200; i++) {
      const rightX = Math.round(x) + i * stepX;
      if (!collides(rightX)) {
        return { x: rightX, y: cy, shifted: true };
      }
    }
    return { x: Math.round(x) + 200 * stepX, y: cy, shifted: true };
  }

  private async placeVertex(args: {
    repositoryId: string;
    modelId: string;
    symbolId: string;
    languageId: string;
    title: string;
    objectType: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    /**
     * Side of this symbol where the primary relation attaches.
     * Outside labels are placed on the opposite side.
     */
    edgeAttachSide?: "top" | "bottom" | "left" | "right";
    outsideLabelSide?: OutsideLabelSide;
    /**
     * In-batch boxes not yet on the canvas. Mutated when a free slot is taken.
     */
    reserved?: Array<{ x: number; y: number; width: number; height: number }>;
    /** Skip overlap nudge (rare; default false). */
    allowOverlap?: boolean;
    /** Keep Y fixed (FLOW spine); only nudge X on collision. */
    spineAlign?: boolean;
  }): Promise<{ uuid?: string; x?: number; y?: number; width?: number; height?: number }> {
    const width = args.width ?? DEFAULT_WIDTH;
    const height = args.height ?? DEFAULT_HEIGHT;

    let x = Math.round(args.x);
    let y = Math.round(args.y);
    if (!args.allowOverlap) {
      const canvas = (await this.client.request({
        path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
        pathParams: {
          repositoryId: args.repositoryId,
          modelId: args.modelId,
        },
      })) as {
        vertices?: Array<{
          x?: number;
          y?: number;
          width?: number;
          height?: number;
        }>;
      };
      const occupied = [
        ...(canvas.vertices ?? []).map((v) => ({
          x: v.x ?? 0,
          y: v.y ?? 0,
          width: v.width ?? DEFAULT_WIDTH,
          height: v.height ?? DEFAULT_HEIGHT,
        })),
        ...(args.reserved ?? []),
      ];
      const free = args.spineAlign
        ? this.findFreePlacementOnSpine(occupied, x, y, width, height)
        : this.findFreePlacement(occupied, x, y, width, height);
      x = free.x;
      y = free.y;
      args.reserved?.push({ x, y, width, height });
    } else {
      args.reserved?.push({ x, y, width, height });
    }

    const outsideLabelSide =
      args.outsideLabelSide ??
      (args.edgeAttachSide
        ? outsideLabelAwayFromEdge(args.edgeAttachSide)
        : undefined);
    const { centerLabel, label } = this.labelBounds({
      objectType: args.objectType,
      title: args.title,
      x,
      y,
      width,
      height,
      outsideLabelSide,
    });
    return (await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
      body: {
        x,
        y,
        width,
        height,
        symbol: args.symbolId,
        centerLabel,
        // Bounds required; title comes from the symbol (cannot set label title on create).
        labels: {
          [args.languageId]: label,
        },
      },
    })) as { uuid?: string; x?: number; y?: number; width?: number; height?: number };
  }

  async applyProposal(args: {
    repositoryId: string;
    languageId: string;
    proposal: ModelProposal;
    permissionGroup?: string;
    owner?: string;
    group?: string;
    modelId?: string;
  }) {
    const proposal = normalizeProposal(args.proposal);
    let modelId = args.modelId;
    const results: unknown[] = [];
    const symbolCache = new Map<string, string>();
    const reserved: Array<{
      x: number;
      y: number;
      width: number;
      height: number;
    }> = [];
    const placed: Array<{
      title: string;
      objectType: string;
      symbolId: string;
      vertexId: string;
      kind?: string;
    }> = [];

    if (!modelId) {
      const created = await this.createProcessModel({
        repositoryId: args.repositoryId,
        title: proposal.title,
        languageId: args.languageId,
        modelType: proposal.modelType,
        permissionGroup: args.permissionGroup,
        owner: args.owner,
        group: args.group,
      });
      results.push({ createModel: created });
      modelId =
        (created.data as { uuid?: string })?.uuid ??
        (created.data as { model?: { uuid?: string } })?.model?.uuid;
    }

    if (!modelId) {
      throw new Error(
        "Could not resolve modelId from create_process_model response; pass modelId explicitly.",
      );
    }

    const chain = proposal.chain ?? [];
    const activityDetails = proposal.activities ?? [];
    const branches = proposal.branches ?? [];
    const detailByTitle = new Map(
      activityDetails.map((a) => [a.title.toLowerCase(), a]),
    );
    const branchLabel = (
      fromTitle: string,
      toTitle: string,
    ): string | undefined => {
      const hit = branches.find(
        (b) =>
          b.fromTitle.toLowerCase() === fromTitle.toLowerCase() &&
          b.toTitle.toLowerCase() === toTitle.toLowerCase(),
      );
      return hit?.label?.trim() || undefined;
    };
    const repoConfig = await this.getRepoConfig(args.repositoryId);
    const { distance } = this.layoutGaps(repoConfig);

    // Process chevron (top-left)
    const processTitle = proposal.processTitle ?? proposal.title;
    const processSize = this.sizeFor(repoConfig, "process");
    const processSymbolId = await this.resolveOrCreateSymbol({
      repositoryId: args.repositoryId,
      languageId: args.languageId,
      title: processTitle,
      objectType: "process",
      owner: args.owner,
      group: args.group,
      cache: symbolCache,
    });
    const processVertex = await this.placeVertex({
      repositoryId: args.repositoryId,
      modelId,
      symbolId: processSymbolId,
      languageId: args.languageId,
      title: processTitle,
      objectType: "process",
      x: 20,
      y: 20,
      width: processSize.width,
      height: processSize.height,
      reserved,
    });
    placed.push({
      title: processTitle,
      objectType: "process",
      symbolId: processSymbolId,
      vertexId: String(processVertex.uuid),
      kind: "process",
    });
    results.push({ processChevron: processVertex });

    // FLOW spine — advance by symbol width + quickdraw left margin
    let previousVertexId: string | undefined;
    let previousTitle: string | undefined;
    let previousKind: string | undefined;
    let cursorX = 50;
    const activityVertices = new Map<
      string,
      { vertexId: string; x: number; y: number; width: number; height: number }
    >();
    const vertexByTitle = new Map<
      string,
      { vertexId: string; x: number; y: number; width: number; height: number; kind: string }
    >();
    const connectedPairs = new Set<string>();

    const spineY = (kind: string): number => {
      if (kind === "businessObject") return Y_BO;
      if (kind === "gateway" || kind === "and") return Y_GATEWAY;
      return Y_ACTIVITY;
    };

    for (const node of chain) {
      const size = this.sizeFor(repoConfig, node.objectType);
      const x = cursorX;
      const y = spineY(node.kind);
      const symbolId = await this.resolveOrCreateSymbol({
        repositoryId: args.repositoryId,
        languageId: args.languageId,
        title: node.title,
        objectType: node.objectType,
        owner: args.owner,
        group: args.group,
        cache: symbolCache,
      });
      const vertex = await this.placeVertex({
        repositoryId: args.repositoryId,
        modelId,
        symbolId,
        languageId: args.languageId,
        title: node.title,
        objectType: node.objectType,
        x,
        y,
        width: size.width,
        height: size.height,
        reserved,
      });
      const vertexId = String(vertex.uuid);
      const usedX = vertex.x ?? x;
      const usedY = vertex.y ?? y;
      placed.push({
        title: node.title,
        objectType: node.objectType,
        symbolId,
        vertexId,
        kind: node.kind,
      });
      vertexByTitle.set(node.title.toLowerCase(), {
        vertexId,
        x: usedX,
        y: usedY,
        width: size.width,
        height: size.height,
        kind: node.kind,
      });

      if (previousVertexId && previousTitle) {
        const label =
          previousKind === "gateway" || previousKind === "and"
            ? branchLabel(previousTitle, node.title)
            : undefined;
        const edge = await this.createCanvasEdge({
          repositoryId: args.repositoryId,
          modelId,
          fromVertexId: previousVertexId,
          toVertexId: vertexId,
          edgeType: "flow",
          languageId: args.languageId,
          label,
        });
        connectedPairs.add(
          `${previousTitle.toLowerCase()}→${node.title.toLowerCase()}`,
        );
        results.push({ flow: edge });
      }
      previousVertexId = vertexId;
      previousTitle = node.title;
      previousKind = node.kind;
      if (node.kind === "activity") {
        activityVertices.set(node.title.toLowerCase(), {
          vertexId,
          x: usedX,
          y: usedY,
          width: size.width,
          height: size.height,
        });
      }
      cursorX = usedX + size.width + distance.left;
    }

    // Side branches from gateways (targets not already adjacent on the spine)
    let branchSlot = 0;
    for (const b of branches) {
      const pairKey = `${b.fromTitle.toLowerCase()}→${b.toTitle.toLowerCase()}`;
      if (connectedPairs.has(pairKey)) {
        continue;
      }
      const from = vertexByTitle.get(b.fromTitle.toLowerCase());
      if (!from) {
        results.push({
          branchSkipped: `fromTitle not placed: ${b.fromTitle}`,
        });
        continue;
      }

      let to = vertexByTitle.get(b.toTitle.toLowerCase());
      if (!to) {
        const toKind = b.toKind ?? "activity";
        const toOt =
          b.objectType ??
          (toKind === "businessObject"
            ? "businessObject"
            : toKind === "gateway"
              ? "or"
              : toKind === "and"
                ? "and"
                : "activity");
        const size = this.sizeFor(repoConfig, toOt);
        const x = from.x + Math.floor((from.width - size.width) / 2);
        const y = from.y + BRANCH_Y_OFFSET + branchSlot * (size.height + distance.bottom);
        branchSlot += 1;
        const symbolId = await this.resolveOrCreateSymbol({
          repositoryId: args.repositoryId,
          languageId: args.languageId,
          title: b.toTitle,
          objectType: toOt,
          owner: args.owner,
          group: args.group,
          cache: symbolCache,
        });
        const vertex = await this.placeVertex({
          repositoryId: args.repositoryId,
          modelId,
          symbolId,
          languageId: args.languageId,
          title: b.toTitle,
          objectType: toOt,
          x,
          y,
          width: size.width,
          height: size.height,
          reserved,
        });
        const vertexId = String(vertex.uuid);
        const usedX = vertex.x ?? x;
        const usedY = vertex.y ?? y;
        placed.push({
          title: b.toTitle,
          objectType: toOt,
          symbolId,
          vertexId,
          kind: toKind,
        });
        to = {
          vertexId,
          x: usedX,
          y: usedY,
          width: size.width,
          height: size.height,
          kind: toKind,
        };
        vertexByTitle.set(b.toTitle.toLowerCase(), to);
        if (toKind === "activity") {
          activityVertices.set(b.toTitle.toLowerCase(), {
            vertexId,
            x: usedX,
            y: usedY,
            width: size.width,
            height: size.height,
          });
        }
      }

      const edge = await this.createCanvasEdge({
        repositoryId: args.repositoryId,
        modelId,
        fromVertexId: from.vertexId,
        toVertexId: to.vertexId,
        edgeType: "flow",
        languageId: args.languageId,
        label: b.label,
      });
      connectedPairs.add(pairKey);
      results.push({ branchFlow: edge });
    }

    // RACI / CONTROLS / IS_USED_BY — pack per side so icons do not stack
    for (const node of chain) {
      if (node.kind !== "activity") continue;
      const activityPlacement = activityVertices.get(node.title.toLowerCase());
      if (!activityPlacement) continue;
      const detail = detailByTitle.get(node.title.toLowerCase());
      if (!detail) continue;

      const activityBox = {
        x: activityPlacement.x,
        y: activityPlacement.y,
        width: activityPlacement.width,
        height: activityPlacement.height,
      };
      const activityVertexId = activityPlacement.vertexId;
      const sideGap = Math.max(distance.bottom, distance.top, 12);

      type Sat = {
        title: string;
        objectType: string;
        edgeType: string;
        kind: string;
        width: number;
        height: number;
      };

      const topSats: Sat[] = detail.controlledBy.map((docTitle) => {
        const size = this.sizeFor(repoConfig, "core_document");
        return {
          title: docTitle,
          objectType: "core_document",
          edgeType: "controls",
          kind: "controls",
          width: size.width,
          height: size.height,
        };
      });

      const roleSats: Sat[] = detail.performers.map((performer) => {
        const size = this.sizeFor(repoConfig, "role");
        return {
          title: performer,
          objectType: "role",
          edgeType: "raciresponsible",
          kind: "performer",
          width: size.width,
          height: size.height,
        };
      });
      const otherBottomSats: Sat[] = detail.usedBy.map((usedTitle) => {
        const usedType =
          detail.usedByTypes?.[usedTitle] ??
          (/mall|checklista|dokument/i.test(usedTitle)
            ? "core_document"
            : "application");
        const size = this.sizeFor(repoConfig, usedType);
        return {
          title: usedTitle,
          objectType: usedType,
          edgeType: "isusedby",
          kind: "usedBy",
          width: size.width,
          height: size.height,
        };
      });

      const placeOne = async (
        sat: Sat,
        pos: { x: number; y: number },
        edgeAttachSide: "top" | "bottom",
      ): Promise<void> => {
        const symbolId = await this.resolveOrCreateSymbol({
          repositoryId: args.repositoryId,
          languageId: args.languageId,
          title: sat.title,
          objectType: sat.objectType,
          owner: args.owner,
          group: args.group,
          cache: symbolCache,
        });
        const satVertex = await this.placeVertex({
          repositoryId: args.repositoryId,
          modelId,
          symbolId,
          languageId: args.languageId,
          title: sat.title,
          objectType: sat.objectType,
          x: pos.x,
          y: pos.y,
          width: sat.width,
          height: sat.height,
          edgeAttachSide,
          reserved,
        });
        await this.createCanvasEdge({
          repositoryId: args.repositoryId,
          modelId,
          fromVertexId: String(satVertex.uuid),
          toVertexId: activityVertexId,
          edgeType: sat.edgeType,
          languageId: args.languageId,
        });
        placed.push({
          title: sat.title,
          objectType: sat.objectType,
          symbolId,
          vertexId: String(satVertex.uuid),
          kind: sat.kind,
        });
      };

      // Top: CONTROLS docs, pack centered above
      if (topSats.length > 0) {
        const packItems = topSats.map((s) => {
          const lab = this.measureOutsideLabel(s.title);
          return {
            width: Math.max(s.width, lab.width),
            height: s.height,
          };
        });
        const positions = this.packAroundActivity({
          activity: activityBox,
          side: "top",
          items: packItems,
          gap: sideGap,
        });
        for (let i = 0; i < topSats.length; i++) {
          const sat = topSats[i];
          const pos = positions[i];
          const pack = packItems[i];
          if (!sat || !pos || !pack) continue;
          await placeOne(
            sat,
            {
              x: pos.x + Math.floor((pack.width - sat.width) / 2),
              y: pos.y,
            },
            "bottom",
          );
        }
      }

      // Bottom: primary role centered; apps/extra roles alternate left/right
      const withPack = (s: Sat) => ({
        title: s.title,
        width: s.width,
        height: s.height,
        packWidth: Math.max(s.width, this.measureOutsideLabel(s.title).width),
      });
      const bottomPositions = this.layoutBottomSatellites({
        activity: activityBox,
        roles: roleSats.map(withPack),
        others: otherBottomSats.map(withPack),
        gap: sideGap,
      });
      for (const sat of [...roleSats, ...otherBottomSats]) {
        const pos = bottomPositions.get(sat.title);
        if (!pos) continue;
        await placeOne(sat, pos, "top");
      }
    }

    return {
      data: {
        modelId,
        placed,
        chainLength: chain.length,
        activityCount: activityDetails.length,
        branchCount: branches.length,
      },
      methodologyNotes: [
        ...(proposal.methodologyNotes ?? []),
        "Applied FLOW chain, RACI_RESPONSIBLE, CONTROLS and IS_USED_BY with reuse-first symbols.",
        "FLOW on activities/processes: left-in / right-out. Roles: one placement under each responsible activity (shared symbol, never fan-out edges).",
        "Vertices are auto-nudged so symbols never stack on the same coordinates.",
        ...(branches.length
          ? [
              "Applied gateway branches with FLOW edge labels (Ja/Nej). Side targets not on the spine are placed below the gateway.",
            ]
          : []),
      ],
      namingChecks: proposal.namingChecks,
      nextSuggestedTools: ["describe_process", "get_process_flow"],
    };
  }

  async setActivityPerformer(args: {
    repositoryId: string;
    modelId: string;
    activityVertexId: string;
    performerSymbolId: string;
    languageId: string;
    performerTitle?: string;
    edgeType?: string;
    x?: number;
    y?: number;
  }) {
    const canvas = (await this.client.request({
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
    })) as {
      vertices?: Array<{
        uuid?: string;
        symbol?: string | { uuid?: string };
        x?: number;
        y?: number;
        width?: number;
        height?: number;
      }>;
      edges?: Array<{
        fromVertex?: string | { uuid?: string };
        toVertex?: string | { uuid?: string };
        edgeType?: string;
      }>;
    };

    const vertexId = (ref: string | { uuid?: string } | undefined): string =>
      typeof ref === "string" ? ref : String(ref?.uuid ?? "");

    // Reuse a role vertex only if it is already RACI-linked to THIS activity.
    // Never fan out one placement to multiple activities — place a copy below each.
    const alreadyLinked = (canvas.edges ?? []).find((e) => {
      const et = (e.edgeType ?? "").toLowerCase().replace(/[_\s-]/g, "");
      if (et !== "raciresponsible" && et !== "responsible") return false;
      if (vertexId(e.toVertex) !== args.activityVertexId) return false;
      const from = (canvas.vertices ?? []).find(
        (v) => v.uuid === vertexId(e.fromVertex),
      );
      const sid =
        typeof from?.symbol === "string" ? from.symbol : from?.symbol?.uuid;
      return sid === args.performerSymbolId;
    });

    let performerVertex = alreadyLinked
      ? (canvas.vertices ?? []).find(
          (v) => v.uuid === vertexId(alreadyLinked.fromVertex),
        )
      : undefined;

    if (performerVertex && alreadyLinked) {
      return {
        data: {
          performerVertex,
          edge: alreadyLinked,
          alreadyLinked: true,
        },
        methodologyNotes: [
          "Performer already RACI-linked to this activity; no new edge created.",
          "Same role on multiple activities: place a vertex under each activity (shared symbol UUID, separate canvas placements).",
        ],
        nextSuggestedTools: ["get_roles_and_responsibilities", "describe_process"],
      };
    }

    const activity = (canvas.vertices ?? []).find(
      (v) => v.uuid === args.activityVertexId,
    );
    const repoConfig = await this.getRepoConfig(args.repositoryId);
    const roleSize = this.sizeFor(repoConfig, "role");
    const { distance } = this.layoutGaps(repoConfig);
    const gap = Math.max(distance.bottom, 12);
    const actX = activity?.x ?? 80;
    const actY = activity?.y ?? Y_BASE;
    const actW = activity?.width ?? DEFAULT_WIDTH;
    const actH = activity?.height ?? DEFAULT_HEIGHT;
    performerVertex = await this.placeVertex({
      repositoryId: args.repositoryId,
      modelId: args.modelId,
      symbolId: args.performerSymbolId,
      languageId: args.languageId,
      title: args.performerTitle ?? "Performer",
      objectType: "role",
      x:
        args.x ??
        Math.round(actX + Math.floor(actW / 2) - Math.floor(roleSize.width / 2)),
      y: args.y ?? Math.round(actY + actH + gap),
      width: roleSize.width,
      height: roleSize.height,
      // Role sits below activity → edge attaches on top → label below
      edgeAttachSide: "top",
    });

    const edge = await this.createCanvasEdge({
      repositoryId: args.repositoryId,
      modelId: args.modelId,
      fromVertexId: String(performerVertex.uuid),
      toVertexId: args.activityVertexId,
      edgeType: args.edgeType ?? "raciresponsible",
      languageId: args.languageId,
    });

    return {
      data: { performerVertex, edge: edge.data },
      methodologyNotes: [
        "Linked performer via RACI_RESPONSIBLE. Placement alone is not ownership.",
        "Same role on multiple activities: place a vertex under each activity (shared symbol UUID, separate canvas placements). Never one role icon with edges to many activities.",
      ],
      nextSuggestedTools: ["get_roles_and_responsibilities", "describe_process"],
    };
  }

  async setStepIo(args: {
    repositoryId: string;
    modelId: string;
    fromVertexId: string;
    toVertexId: string;
    languageId: string;
    edgeType?: string;
  }) {
    return this.createCanvasEdge({
      repositoryId: args.repositoryId,
      modelId: args.modelId,
      fromVertexId: args.fromVertexId,
      toVertexId: args.toVertexId,
      edgeType: args.edgeType ?? "flow",
      languageId: args.languageId,
    });
  }

  async placeInSwimlane(args: {
    repositoryId: string;
    modelId: string;
    symbolId: string;
    x: number;
    y: number;
  }) {
    // Swimlane assignment is primarily positional relative to lane geometry
    const vertex = await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/models/{modelId}/canvas/vertices",
      pathParams: {
        repositoryId: args.repositoryId,
        modelId: args.modelId,
      },
      body: {
        x: args.x,
        y: args.y,
        width: DEFAULT_WIDTH,
        height: DEFAULT_HEIGHT,
        symbol: args.symbolId,
      },
    });
    return {
      data: vertex,
      methodologyNotes: [
        "Placed symbol at swimlane coordinates; lane owner becomes performer for objects in the lane.",
      ],
      nextSuggestedTools: ["get_roles_and_responsibilities", "get_process_flow"],
    };
  }
}
