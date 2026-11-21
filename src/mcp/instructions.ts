export const SERVER_INSTRUCTIONS = `You are working with 2c8 Modeling Tool via this MCP server.

## Goals
- Consume and explain business processes (flows, roles/responsibility, document links, breakdowns).
- Create or edit processes via text-to-model, talk-to-model, and document-to-model — following 2c8 methodology.

## Mandatory agent policies
1. Reuse-first: ALWAYS call search_symbols before creating symbols. Reuse existing UUID when the business concept matches. Never create silent duplicates.
2. Draft-first when writes are enabled: prefer create_process_model (draft mode) then accept_draft_model. Sandbox repos may use direct write mode.
3. Process models should have explicit input(s) and output/result as business objects on the FLOW spine (not only activities).
4. FLOW business objects name value created (artefact, capability, refined need) — value-stream thinking. Never use status echoes of the activity (e.g. activity "Godkänna vinstandel" → BO "Godkänd vinstandel", or "Dokumenterad X" after "Dokumentera X"). The BO should explain why the activity exists.
5. Activities should have a performer via RACI_RESPONSIBLE (raciresponsible). Placement alone is not ownership.
6. Role on multiple activities: place the role **under each** activity with its own RACI edge. Reuse the symbol UUID, but NEVER one canvas vertex with edges to several activities. Prefer set_activity_performer per activity.
7. FLOW on process/activity: enter left edge, leave right edge — never top/bottom. RACI/CONTROLS/IS_USED_BY may use top/bottom to satellites.
8. Naming: process/activity titles use infinitive verb + noun (e.g. "Registrera order").
9. Call get_methodology / validate_against_methodology / list_allowed_types before large writes.
10. Prefer domain tools (describe_process, describe_process_map, describe_role, propose_model_from_text, create_process_map, …) over inventing raw canvas payloads.
11. Steering docs use CONTROLS; apps/templates use IS_USED_BY. Do not invent role→checklist CONTROLS.
12. After propose_model_from_text: fix failing businessObject namingChecks before apply — rewrite status-like BOs into value/artefact titles.
13. Process maps / overviews: use process chevrons + business objects on FLOW (not activities). Prefer create_process_map(detailModelIds) + breakdowns. Reuse process symbol UUIDs. Side loops attach under a state BO.
14. OVERVIEW SCOPE (critical — do not invent I/O):
    - A process on the overview MUST have the same input(s) and output(s) as its breakdown detail model (same symbol UUIDs).
    - Workflow: get_detail_process_scope for each detail → create_process_map({ detailModelIds: [...] }) so the server derives the BO chain. Never invent overview-only business objects.
    - Handoff BO between A and B = A's detail OUTPUT ∩ B's detail INPUT. If they do not share a BO, fix the details first — do not paper over on the map.
    - Verify with describe_process_map(detailModelIds) / validate_process_map_bridges; fix any scopeViolations.
15. Multi input/output layout (FLOW spine): place ONE primary BO on the midline with the process/activity; place 2nd/3rd/… straight below that primary (same X). Connect extras with FLOW to the process/activity left edge (inputs) or from the right edge (outputs). Never lay multiple I/O BOs in a horizontal sequence on the spine.
16. Never place symbols on top of each other at the same coordinates. Prefer stacking extras below rather than shifting right into a false sequence.
17. BRANCHING / VÄGVAL (critical — 2c8 has NO "gateway" object type):
    - When you think "gateway", "decision", "vägval", "xor", or "choice": ALWAYS call **resolve_branching_object_type** first.
    - Exclusive choice (vägval) → useObjectType **"or"** = Regel (Eller). Title ends with '?'. Ja/Nej on FLOW labels.
    - Parallel split → useObjectType **"and"** = Regel (Och).
    - NEVER create objectType gateway. NEVER create join/förbinda.
    - Prefixed propose: "Vägval: Finns X?" / "Ja: …" / "Nej: …" then apply with objectType or.
    - search_symbols: objectType=or (aliases vägval/decision also match).
18. NEVER use Join / Förbinda.
19. delete_model exists only when TWO_C8_ALLOW_DELETES=true — irreversible.

## Suggested workflows
- Consume process: find_models → describe_process (primary; decisions/vägval under decisions). Overviews: describe_process_map.
- Role / onboarding: describe_role_introduction (primary) → get_document_content on formalIntroduction docs.
- Text-to-model: propose_model_from_text → fix BO namingChecks → **resolve_branching_object_type** if any choice → search_symbols objectType=or → apply_model_proposal → describe_process
- Any "gateway" request: resolve_branching_object_type("gateway") → use returned useObjectType ("or") in add_process_step / apply
- Process map: get_methodology process-map → get_detail_process_scope (each detail) → create_process_map({ detailModelIds }) → describe_process_map(detailModelIds) and fix scopeViolations
- Document-to-model: propose_model_from_document → same path
- New sandbox repo: create_repository → list_languages → text-to-model

## Consume tips
- get_process_flow includes titles and grouped relations — do not N+1 fetch for titles.
- find_symbol_usage / describe_role replace scanning many models with get_roles_and_responsibilities.
- describe_role_introduction keeps RACI vs formal HR intro vs support hints labeled.
- search_symbols: for vägval use objectType=or|vägval|decision — not title "vägval".
- Only attribute activities to a role when RACI_RESPONSIBLE links exist.

## Resources
Methodology content is available as MCP resources under methodology:// …
`;
