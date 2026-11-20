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
  };
  if (map[key]) return map[key];
  if (objectType.includes("_")) return objectType.toLowerCase();
  return objectType.toLowerCase();
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
      const symbol = (await this.client.request({
        method: "POST",
        path: "/api/v1/repositories/{repositoryId}/symbols",
        pathParams: { repositoryId: args.repositoryId },
        body: {
          objectType,
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
    })) as { vertices?: Array<{ x?: number; y?: number }> };

    const count = canvas.vertices?.length ?? 0;
    const stepGap = size.width + distance.left;
    const x = args.x ?? 80 + count * stepGap;
    const y = args.y ?? Y_BASE;

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
      methodologyNotes: validation.methodologyNotes,
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
      ],
      nextSuggestedTools: ["get_breakdowns", "get_process_flow"],
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
   * Orthogonal polyline with endpoints on symbol borders (not centers).
   * Stacked symbols (above/below) always use top↔bottom on the activity's
   * horizontal center — even when the satellite is horizontally offset.
   */
  private orthogonalPoints(
    from: { x?: number; y?: number; width?: number; height?: number },
    to: { x?: number; y?: number; width?: number; height?: number },
  ): Array<{ x: number; y: number }> {
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
      // Satellite below → activity: leave satellite top, enter activity bottom (center)
      p0 = { x: fromCenter.x, y: fy, side: "top" };
      pN = { x: toCenter.x, y: ty + th, side: "bottom" };
    } else if (fromAbove) {
      // Satellite above → activity: leave satellite bottom, enter activity top (center)
      p0 = { x: fromCenter.x, y: fy + fh, side: "bottom" };
      pN = { x: toCenter.x, y: ty, side: "top" };
    } else {
      p0 = this.borderAttachment(from, toCenter);
      pN = this.borderAttachment(to, fromCenter);
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
      }>;
    };
    const from = (canvas.vertices ?? []).find((v) => v.uuid === args.fromVertexId);
    const to = (canvas.vertices ?? []).find((v) => v.uuid === args.toVertexId);
    const points = this.orthogonalPoints(from ?? {}, to ?? {});
    const midX = Math.floor(((points[0]?.x ?? 0) + (points[points.length - 1]?.x ?? 0)) / 2);
    const midY = Math.floor(((points[0]?.y ?? 0) + (points[points.length - 1]?.y ?? 0)) / 2) - 10;

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
            title: "",
            rawTitle: "",
            x: midX,
            y: midY,
            width: 40,
            height: 20,
          },
        },
      },
    });
    return {
      data: edge,
      methodologyNotes: [
        `Created canvas edge type=${edgeType}. Common types: FLOW, RACI_RESPONSIBLE, CONTROLS, IS_USED_BY.`,
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

    const symbol = (await this.client.request({
      method: "POST",
      path: "/api/v1/repositories/{repositoryId}/symbols",
      pathParams: { repositoryId: args.repositoryId },
      body: {
        objectType: apiType,
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
  }): Promise<{ uuid?: string; x?: number; y?: number; width?: number; height?: number }> {
    const width = args.width ?? DEFAULT_WIDTH;
    const height = args.height ?? DEFAULT_HEIGHT;
    const outsideLabelSide =
      args.outsideLabelSide ??
      (args.edgeAttachSide
        ? outsideLabelAwayFromEdge(args.edgeAttachSide)
        : undefined);
    const { centerLabel, label } = this.labelBounds({
      objectType: args.objectType,
      title: args.title,
      x: args.x,
      y: args.y,
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
        x: args.x,
        y: args.y,
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
    const detailByTitle = new Map(
      activityDetails.map((a) => [a.title.toLowerCase(), a]),
    );
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
    let cursorX = 50;
    const activityVertices = new Map<
      string,
      { vertexId: string; x: number; y: number; width: number; height: number }
    >();

    for (const node of chain) {
      const isBo = node.kind === "businessObject";
      const size = this.sizeFor(repoConfig, node.objectType);
      const x = cursorX;
      const y = isBo ? Y_BO : Y_ACTIVITY;
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
      });
      const vertexId = String(vertex.uuid);
      placed.push({
        title: node.title,
        objectType: node.objectType,
        symbolId,
        vertexId,
        kind: node.kind,
      });

      if (previousVertexId) {
        const edge = await this.createCanvasEdge({
          repositoryId: args.repositoryId,
          modelId,
          fromVertexId: previousVertexId,
          toVertexId: vertexId,
          edgeType: "flow",
          languageId: args.languageId,
        });
        results.push({ flow: edge });
      }
      previousVertexId = vertexId;
      if (!isBo) {
        activityVertices.set(node.title.toLowerCase(), {
          vertexId,
          x,
          y,
          width: size.width,
          height: size.height,
        });
      }
      cursorX += size.width + distance.left;
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
      },
      methodologyNotes: [
        ...(proposal.methodologyNotes ?? []),
        "Applied FLOW chain, RACI_RESPONSIBLE, CONTROLS and IS_USED_BY with reuse-first symbols.",
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
      }>;
    };

    let performerVertex = (canvas.vertices ?? []).find((v) => {
      const sid =
        typeof v.symbol === "string" ? v.symbol : v.symbol?.uuid;
      return sid === args.performerSymbolId;
    });

    if (!performerVertex) {
      const activity = (canvas.vertices ?? []).find(
        (v) => v.uuid === args.activityVertexId,
      );
      const repoConfig = await this.getRepoConfig(args.repositoryId);
      const roleSize = this.sizeFor(repoConfig, "role");
      performerVertex = await this.placeVertex({
        repositoryId: args.repositoryId,
        modelId: args.modelId,
        symbolId: args.performerSymbolId,
        languageId: args.languageId,
        title: args.performerTitle ?? "Performer",
        objectType: "role",
        x: args.x ?? (activity?.x ?? 80),
        y: args.y ?? (activity?.y ?? Y_BASE) + 160,
        width: roleSize.width,
        height: roleSize.height,
        // Role sits below activity → edge attaches on top → label below
        edgeAttachSide: "top",
      });
    }

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
