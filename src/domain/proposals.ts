import type { MethodologyPack } from "../methodology/loader.js";
import {
  checkNaming,
  methodologyNotesForObject,
} from "../methodology/rules-engine.js";

/** Node on the main FLOW spine (business object or activity). */
export interface ProposedChainNode {
  kind: "businessObject" | "activity";
  title: string;
  objectType: string;
}

/** Per-activity relations outside the FLOW spine. */
export interface ProposedActivityDetail {
  title: string;
  performers: string[];
  /** CORE_DOCUMENT titles linked with CONTROLS. */
  controlledBy: string[];
  /** APPLICATION or CORE_DOCUMENT titles linked with IS_USED_BY. */
  usedBy: string[];
  /** Object type hint per usedBy title (default application vs core_document). */
  usedByTypes?: Record<string, string>;
}

/** Legacy step shape kept for backward-compatible apply/Zod. */
export interface ProposedStep {
  title: string;
  objectType: string;
  performerTitle?: string;
  performers?: string[];
  inputs?: string[];
  outputs?: string[];
  documents?: string[];
  controlledBy?: string[];
  usedBy?: string[];
}

export interface ModelProposal {
  modelType: string;
  title: string;
  /** Process chevron title (defaults to title). */
  processTitle?: string;
  /** Ordered FLOW chain: BO → activity → BO → … */
  chain?: ProposedChainNode[];
  /** Activity-level RACI / CONTROLS / IS_USED_BY. */
  activities?: ProposedActivityDetail[];
  /** Derived/legacy linear steps (compat). */
  steps: ProposedStep[];
  methodologyNotes: string[];
  namingChecks: Array<{
    title: string;
    objectType: string;
    pass: boolean;
    hint?: string;
  }>;
  nextSuggestedTools: string[];
}

const ACTIVITY_HINTS =
  /^(aktivitet|activity|steg|step)\s*[:\-–]\s*/i;
const ROLE_HINTS = /^(roll|role|ansvarig|befattning|utförare)\s*[:\-–]\s*/i;
const DOC_HINTS = /^(dokument|document|länk|link|styrdokument|checklista)\s*[:\-–]\s*/i;
const INPUT_HINTS = /^(input|in|ingång|start|tillstånd)\s*[:\-–]\s*/i;
const OUTPUT_HINTS = /^(output|ut|resultat|utgång)\s*[:\-–]\s*/i;
const PROCESS_TITLE = /^(process|processmodell|modell)\s*[:\-–]\s*/i;
const APP_HINTS = /^(applikation|application|system|it-stöd|itstöd)\s*[:\-–]\s*/i;
const USED_BY_HINTS = /^(används|mall|verktyg)\s*[:\-–]\s*/i;

function capitalizeFirst(s: string): string {
  const t = s.trim();
  if (!t) return t;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function cleanTitle(line: string): string {
  return line
    .replace(/^[-*•\d.)\s]+/, "")
    .replace(ACTIVITY_HINTS, "")
    .replace(ROLE_HINTS, "")
    .replace(DOC_HINTS, "")
    .replace(INPUT_HINTS, "")
    .replace(OUTPUT_HINTS, "")
    .replace(PROCESS_TITLE, "")
    .replace(APP_HINTS, "")
    .replace(USED_BY_HINTS, "")
    .trim();
}

function guessObjectType(line: string): string {
  const lower = line.toLowerCase();
  if (ROLE_HINTS.test(line) || /\b(roll|befattning)\b/.test(lower)) {
    return "role";
  }
  if (DOC_HINTS.test(line)) {
    return "core_document";
  }
  if (APP_HINTS.test(line)) {
    return "application";
  }
  if (INPUT_HINTS.test(line) || OUTPUT_HINTS.test(line)) {
    return "businessObject";
  }
  return "activity";
}

function stepsFromChain(
  chain: ProposedChainNode[],
  activities: ProposedActivityDetail[],
): ProposedStep[] {
  const byTitle = new Map(activities.map((a) => [a.title.toLowerCase(), a]));
  return chain.map((node) => {
    if (node.kind === "activity") {
      const detail = byTitle.get(node.title.toLowerCase());
      return {
        title: node.title,
        objectType: "activity",
        performers: detail?.performers,
        performerTitle: detail?.performers?.[0],
        controlledBy: detail?.controlledBy,
        usedBy: detail?.usedBy,
        documents: detail?.controlledBy,
      };
    }
    return {
      title: node.title,
      objectType: "businessObject",
    };
  });
}

function buildNamingChecks(
  pack: MethodologyPack,
  chain: ProposedChainNode[],
  activities: ProposedActivityDetail[],
): ModelProposal["namingChecks"] {
  const checks: ModelProposal["namingChecks"] = [];
  for (const node of chain) {
    const c = checkNaming(pack, node.objectType, node.title);
    checks.push({
      title: node.title,
      objectType: node.objectType,
      pass: c.pass,
      hint: c.hint,
    });
  }
  for (const act of activities) {
    for (const p of act.performers) {
      const c = checkNaming(pack, "role", p);
      checks.push({
        title: p,
        objectType: "role",
        pass: c.pass,
        hint: c.hint,
      });
    }
    for (const d of act.controlledBy) {
      const c = checkNaming(pack, "core_document", d);
      checks.push({
        title: d,
        objectType: "core_document",
        pass: c.pass,
        hint: c.hint,
      });
    }
    for (const u of act.usedBy) {
      const ot = act.usedByTypes?.[u] ?? "application";
      const c = checkNaming(pack, ot, u);
      checks.push({ title: u, objectType: ot, pass: c.pass, hint: c.hint });
    }
  }
  return checks;
}

function finalizeProposal(
  pack: MethodologyPack,
  modelType: string,
  title: string,
  chain: ProposedChainNode[],
  activities: ProposedActivityDetail[],
  extraNotes: string[] = [],
): ModelProposal {
  const steps = stepsFromChain(chain, activities);
  return {
    modelType,
    title,
    processTitle: title,
    chain,
    activities,
    steps,
    methodologyNotes: [
      ...methodologyNotesForObject(pack, "process"),
      "Proposal includes FLOW chain (business objects + activities), RACI performers, CONTROLS and IS_USED_BY.",
      "Search for reusable symbols before apply_model_proposal.",
      ...extraNotes,
    ],
    namingChecks: buildNamingChecks(pack, chain, activities),
    nextSuggestedTools: [
      "validate_against_methodology",
      "search_symbols",
      "apply_model_proposal",
    ],
  };
}

/** Normalize spoken role phrases to symbol titles. */
function normalizeRole(raw: string): string {
  const t = raw.trim().replace(/\s+/g, " ");
  const lower = t.toLowerCase();
  if (/^kandidaten?$/.test(lower) || /kandidat/.test(lower)) {
    return "Kandidat för anställning";
  }
  if (/personalansvarig/.test(lower)) {
    return "Personalansvarig";
  }
  if (/servicetekniker/.test(lower)) {
    return "Servicetekniker";
  }
  return capitalizeFirst(t);
}

function extractRolesFromSentence(sentence: string): string[] {
  const roles: string[] = [];
  const lower = sentence.toLowerCase();
  if (lower.includes("personalansvarig")) {
    roles.push("Personalansvarig");
  }
  if (/\bkandidaten?\b/.test(lower) || /kandidat för/.test(lower)) {
    roles.push("Kandidat för anställning");
  }
  if (lower.includes("servicetekniker")) {
    roles.push("Servicetekniker");
  }
  // "X och Y ... ansvaret"
  const ans = sentence.match(
    /(?:delar|tar)\s+([^,.]+?)\s+(?:och\s+([^,.]+?)\s+)?(?:på\s+)?ansvaret/i,
  );
  if (ans) {
    for (const g of [ans[1], ans[2]]) {
      if (!g) continue;
      const parts = g.split(/\s+och\s+/i);
      for (const p of parts) {
        const n = normalizeRole(p.replace(/^en\s+/i, "").trim());
        if (n && !roles.includes(n)) roles.push(n);
      }
    }
  }
  return roles;
}

function looksLikeNarrative(text: string): boolean {
  const lower = text.toLowerCase();
  const paras = text.split(/\n\s*\n/).filter((p) => p.trim());
  if (paras.length >= 2 && /först|därefter|sedan|sista|heter\s+/i.test(lower)) {
    return true;
  }
  if (/heter\s+\S+/.test(lower) && /när\s+/.test(lower)) {
    return true;
  }
  // Prose paragraphs without "Aktivitet:" prefixes
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const prefixed = lines.filter(
    (l) =>
      ACTIVITY_HINTS.test(l) ||
      ROLE_HINTS.test(l) ||
      PROCESS_TITLE.test(l) ||
      INPUT_HINTS.test(l),
  ).length;
  return lines.length >= 2 && prefixed === 0 && text.length > 120;
}

/**
 * Swedish narrative → structured process proposal (recruitment-style and similar).
 */
function proposeFromNarrative(
  pack: MethodologyPack,
  text: string,
  modelType: string,
): ModelProposal | null {
  if (!looksLikeNarrative(text)) {
    return null;
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const full = paragraphs.join(" ");

  // Title: "heter X," / "processen X"
  let title = "Ny process";
  const heter = full.match(
    /heter\s+([A-ZÅÄÖÉa-zåäöé][^,.]{2,80}?)(?:,|\s+och\s+den|\s*$)/,
  );
  if (heter) {
    title = capitalizeFirst(heter[1].trim());
  } else {
    const named = full.match(
      /(?:process(?:en|modell)?)\s+([A-ZÅÄÖ][^,.]{2,60})/,
    );
    if (named) title = capitalizeFirst(named[1].trim());
  }

  // Start BO from "sätter igång när …" / "startar när …"
  let startBo: string | undefined;
  const startMatch = full.match(
    /(?:sätter igång|startar|börjar)\s+när\s+(?:det finns\s+)?(?:ett\s+)?([^,.]+)/i,
  );
  if (startMatch) {
    let raw = startMatch[1].trim();
    // "beslut att ta in en ny medarbetare" → "Beslut att ta in ny anställd"
    raw = raw
      .replace(/\ben ny medarbetare\b/gi, "ny anställd")
      .replace(/\ben nyanställd\b/gi, "ny anställd");
    startBo = capitalizeFirst(raw);
  }

  const chain: ProposedChainNode[] = [];
  const activities: ProposedActivityDetail[] = [];

  if (startBo) {
    chain.push({
      kind: "businessObject",
      title: startBo,
      objectType: "businessObject",
    });
  }

  const stepParas =
    paragraphs.length >= 2 ? paragraphs.slice(1) : paragraphs;

  for (let i = 0; i < stepParas.length; i++) {
    const para = stepParas[i];
    const lower = para.toLowerCase();
    const isLast = i === stepParas.length - 1;

    // Skip if this is the opening para already used for title/start
    if (
      i === 0 &&
      paragraphs.length >= 2 &&
      /heter\s+/i.test(paragraphs[0]) &&
      para === paragraphs[0]
    ) {
      continue;
    }

    let activityTitle: string | undefined;
    const performers = extractRolesFromSentence(para);
    const controlledBy: string[] = [];
    const usedBy: string[] = [];
    const usedByTypes: Record<string, string> = {};

    // Activity title heuristics
    if (/bestämmer villkor|bestämma villkor|villkoren för anställning/i.test(para)) {
      activityTitle = "Bestämma villkor för anställning";
    } else if (/förbereder|förbereda/.test(lower) && /medarbetare|nyanställd|personen ska börja/i.test(para)) {
      activityTitle = "Förbereda för medarbetare";
    } else if (/introduktion/i.test(para)) {
      activityTitle = "Genomföra introduktion";
    } else if (/först\s+/i.test(para) || /därefter\s+/i.test(para) || /sedan\s+/i.test(para) || /sista\s+/i.test(para)) {
      // Generic: try "verb ... noun" after connector
      const m = para.match(
        /(?:först|därefter|sedan|sista steget(?: är)?)\s+(?:är\s+)?(.+?)(?:\.|,| och | där )/i,
      );
      if (m) {
        const frag = m[1].trim();
        if (/introduktion/i.test(frag)) {
          activityTitle = "Genomföra introduktion";
        } else {
          activityTitle = capitalizeFirst(frag.slice(0, 80));
        }
      }
    }

    // Fallback: first infinitive-like verb phrase
    if (!activityTitle) {
      const verb = para.match(
        /\b(bestämmer|förbereder|genomför|registrerar|godkänner|granskar|skickar|kontrollerar)\s+([^,.]+)/i,
      );
      if (verb) {
        const map: Record<string, string> = {
          bestämmer: "Bestämma",
          förbereder: "Förbereda",
          genomför: "Genomföra",
          registrerar: "Registrera",
          godkänner: "Godkänna",
          granskar: "Granska",
          skickar: "Skicka",
          kontrollerar: "Kontrollera",
        };
        const v = map[verb[1].toLowerCase()] ?? capitalizeFirst(verb[1]);
        activityTitle = `${v} ${verb[2].trim()}`.replace(/\s+/g, " ").slice(0, 80);
      }
    }

    if (!activityTitle) {
      continue;
    }

    // CONTROLS: "styrs av X" / "stöd av X" / checklista
    const styr = para.match(
      /styrs av\s+(?:den\s+)?([^,.]+)|stöd av\s+(?:samma\s+|den\s+)?([^,.]+)|(?:checklista(?:n)?\s+(?:för\s+)?onboarding)/i,
    );
    if (styr || /onboardingchecklista|checklista(?:n)?\s+(?:för\s+)?onboarding/i.test(para)) {
      controlledBy.push("Checklista onboarding");
    }

    // IS_USED_BY mall
    if (/mall(?:en)?\s+för\s+anställningsavtal|anställningsavtal/i.test(para) && /utgår från|mall/i.test(para)) {
      usedBy.push("Mall anställningsavtal");
      usedByTypes["Mall anställningsavtal"] = "core_document";
    }

    // Application: personalliggare / system
    const appMatch = para.match(
      /(?:i|via)\s+([A-ZÅÄÖÉa-zåäöé][^,.]{0,40}?(?:personalliggare|system|liggare|portal|register))/i,
    );
    if (appMatch) {
      let app = appMatch[1].trim();
      app = app.replace(/\s+s\s+/i, "s "); // Lättkrängts → keep
      if (/personalliggare/i.test(app)) {
        app = /lättkrängt/i.test(app)
          ? "Lättkrängt Personalliggare"
          : capitalizeFirst(app.replace(/s\s+personalliggare/i, " Personalliggare"));
      } else {
        app = capitalizeFirst(app);
      }
      usedBy.push(app);
      usedByTypes[app] = "application";
    } else if (/personalliggare/i.test(para)) {
      const app = /lättkrängt/i.test(para)
        ? "Lättkrängt Personalliggare"
        : "Personalliggare";
      usedBy.push(app);
      usedByTypes[app] = "application";
    }

    // Ensure personalansvarig when "tar personalansvarig vid"
    if (/personalansvarig/i.test(para) && !performers.includes("Personalansvarig")) {
      performers.unshift("Personalansvarig");
    }

    chain.push({
      kind: "activity",
      title: activityTitle,
      objectType: "activity",
    });
    activities.push({
      title: activityTitle,
      performers: [...new Set(performers)],
      controlledBy: [...new Set(controlledBy)],
      usedBy: [...new Set(usedBy)],
      usedByTypes,
    });

    // Result BO after activity: "när … har man X" / "när … finns X" / "är X — landa"
    let resultBo: string | undefined;
    const resultMatch = para.match(
      /när\s+[^,]{5,80}?,\s*(?:har man|finns|är)\s+(?:ett\s+|en\s+|alla\s+)?([^—.]+)/i,
    );
    if (resultMatch) {
      resultBo = capitalizeFirst(
        resultMatch[1]
          .replace(/\s+för den nyanställda\.?$/i, " för nyanställd")
          .replace(/\s+och det är också.*$/i, "")
          .trim(),
      );
    }

    // Last paragraph landing: "redo att arbeta självständigt" / "landa i"
    if (isLast || /landa|landar|redo att arbeta/i.test(para)) {
      const landa = para.match(
        /(?:är\s+)?medarbetaren\s+redo[^.]*|([^.]{5,80}redo att arbeta självständigt)/i,
      );
      if (landa) {
        resultBo = "Medarbetare redo att arbeta självständigt";
      }
    }

    // Specific known results
    if (/påskrivet anställningsavtal/i.test(para)) {
      resultBo = "Påskrivet anställningsavtal";
    }
    if (/alla förutsättningar på plats/i.test(para)) {
      resultBo = "Alla förutsättningar på plats för nyanställd";
    }

    if (resultBo) {
      chain.push({
        kind: "businessObject",
        title: resultBo,
        objectType: "businessObject",
      });
    }
  }

  if (chain.filter((n) => n.kind === "activity").length === 0) {
    return null;
  }

  // Ensure end BO if last node is activity and text mentions landing
  const last = chain[chain.length - 1];
  if (last?.kind === "activity" && /redo att arbeta|landa/i.test(full)) {
    chain.push({
      kind: "businessObject",
      title: "Medarbetare redo att arbeta självständigt",
      objectType: "businessObject",
    });
  }

  return finalizeProposal(pack, modelType, title, chain, activities, [
    "Extracted from Swedish narrative prose.",
  ]);
}

/**
 * Prefix-line heuristic (Aktivitet:, Roll:, Input:, …).
 */
function proposeFromPrefixedLines(
  pack: MethodologyPack,
  text: string,
  modelType: string,
): ModelProposal {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  let title = "Ny process";
  const chain: ProposedChainNode[] = [];
  const activities: ProposedActivityDetail[] = [];
  let pendingPerformers: string[] = [];
  const docs: string[] = [];
  const usedBy: string[] = [];
  const usedByTypes: Record<string, string> = {};
  const inputs: string[] = [];
  const outputs: string[] = [];

  const flushBo = (t: string) => {
    chain.push({
      kind: "businessObject",
      title: t,
      objectType: "businessObject",
    });
  };

  for (const line of lines) {
    if (PROCESS_TITLE.test(line) || (chain.length === 0 && !line.includes(":") && lines.indexOf(line) === 0)) {
      if (PROCESS_TITLE.test(line) || lines.indexOf(line) === 0) {
        const cleaned = cleanTitle(line);
        if (cleaned && PROCESS_TITLE.test(line)) {
          title = cleaned;
          continue;
        }
        if (lines.indexOf(line) === 0 && !ACTIVITY_HINTS.test(line)) {
          title = cleaned || title;
          continue;
        }
      }
    }

    if (ROLE_HINTS.test(line)) {
      pendingPerformers.push(normalizeRole(cleanTitle(line)));
      continue;
    }
    if (DOC_HINTS.test(line)) {
      docs.push(cleanTitle(line));
      continue;
    }
    if (APP_HINTS.test(line) || USED_BY_HINTS.test(line)) {
      const t = cleanTitle(line);
      usedBy.push(t);
      usedByTypes[t] = APP_HINTS.test(line) ? "application" : "core_document";
      continue;
    }
    if (INPUT_HINTS.test(line)) {
      inputs.push(cleanTitle(line));
      continue;
    }
    if (OUTPUT_HINTS.test(line)) {
      outputs.push(cleanTitle(line));
      continue;
    }

    const objectType = guessObjectType(line);
    const stepTitle = cleanTitle(line);
    if (!stepTitle) continue;

    if (objectType === "activity") {
      for (const inp of inputs) flushBo(inp);
      inputs.length = 0;

      chain.push({
        kind: "activity",
        title: stepTitle,
        objectType: "activity",
      });
      activities.push({
        title: stepTitle,
        performers: [...pendingPerformers],
        controlledBy: [...docs],
        usedBy: [...usedBy],
        usedByTypes: { ...usedByTypes },
      });
      pendingPerformers = [];
      docs.length = 0;
      usedBy.length = 0;
      for (const k of Object.keys(usedByTypes)) delete usedByTypes[k];

      for (const out of outputs) flushBo(out);
      outputs.length = 0;
    } else if (objectType === "businessObject") {
      flushBo(stepTitle);
    } else if (objectType === "role") {
      pendingPerformers.push(normalizeRole(stepTitle));
    } else if (objectType === "core_document") {
      docs.push(stepTitle);
    } else if (objectType === "application") {
      usedBy.push(stepTitle);
      usedByTypes[stepTitle] = "application";
    }
  }

  if (chain.length === 0) {
    for (const line of lines.slice(0, 20)) {
      const t = cleanTitle(line);
      if (t && t !== title) {
        chain.push({ kind: "activity", title: t, objectType: "activity" });
        activities.push({
          title: t,
          performers: [],
          controlledBy: [],
          usedBy: [],
        });
      }
    }
  }

  return finalizeProposal(pack, modelType, title, chain, activities, [
    "Extracted from prefixed / structured lines.",
  ]);
}

/**
 * Text → process proposal (no API writes).
 * Prefers Swedish narrative extraction; falls back to prefix-line parser.
 */
export function proposeModelFromText(
  pack: MethodologyPack,
  text: string,
  modelType = "process",
): ModelProposal {
  const narrative = proposeFromNarrative(pack, text, modelType);
  if (narrative) {
    return narrative;
  }
  return proposeFromPrefixedLines(pack, text, modelType);
}

export function proposeModelFromDocument(
  pack: MethodologyPack,
  args: { title?: string; text: string; sourceUrl?: string },
): ModelProposal {
  const proposal = proposeModelFromText(pack, args.text, "process");
  if (args.title) {
    proposal.title = args.title;
    proposal.processTitle = args.title;
  }
  proposal.methodologyNotes = [
    ...proposal.methodologyNotes,
    "Derived from document text (document-to-model). Review extracted steps before apply.",
    args.sourceUrl ? `Source: ${args.sourceUrl}` : "",
  ].filter(Boolean);
  return proposal;
}

/** Ensure chain/activities exist when only legacy steps were supplied. */
export function normalizeProposal(proposal: ModelProposal): ModelProposal {
  if (proposal.chain?.length && proposal.activities) {
    return proposal;
  }
  const chain: ProposedChainNode[] = [];
  const activities: ProposedActivityDetail[] = [];
  for (const step of proposal.steps) {
    const ot = step.objectType.toLowerCase();
    if (ot.includes("business") || ot === "businessobject") {
      chain.push({
        kind: "businessObject",
        title: step.title,
        objectType: "businessObject",
      });
    } else {
      chain.push({
        kind: "activity",
        title: step.title,
        objectType: "activity",
      });
      activities.push({
        title: step.title,
        performers:
          step.performers ??
          (step.performerTitle ? [step.performerTitle] : []),
        controlledBy: step.controlledBy ?? step.documents ?? [],
        usedBy: step.usedBy ?? [],
      });
    }
  }
  return {
    ...proposal,
    processTitle: proposal.processTitle ?? proposal.title,
    chain,
    activities,
    steps: stepsFromChain(chain, activities),
  };
}
