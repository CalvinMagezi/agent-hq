import * as fs from "fs";
import * as path from "path";
import matter from "gray-matter";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";
import {
  openPlanDB,
  upsertPlan,
  getPlan,
  getPendingQuestions,
  answerQuestion,
  searchPlans,
  searchPatterns,
  upsertCodemapEntry,
  upsertConvention,
  getCodemapForProject,
  getConventionsForProject,
  addPlanAsset,
  getPlanAssets,
  removePlanAsset,
  type AmbiguitySignal,
  type PlanAsset,
  type PlanManifest,
  type PlanPhase,
} from "../planDB.js";
import { CodemapEngine } from "../codemap.js";
import { PlanKnowledgeEngine } from "../planKnowledge.js";
import { detectAmbiguity } from "../ambiguityDetector.js";
import { getPlanningMode, MODE_CONFIGS, type PlanningMode } from "../planningModes.js";
import { buildStructuredDiagram, renderPipeline } from "./drawit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPlanDB(ctx: HQContext) {
  if (ctx.planDB) return ctx.planDB;
  return openPlanDB(ctx.vaultPath);
}

function detectProject(instruction: string, vaultPath: string): string {
  const lower = instruction.toLowerCase();
  const projectsDir = path.join(vaultPath, "Notebooks", "Projects");
  if (fs.existsSync(projectsDir)) {
    const projects = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const proj of projects) {
      const variants = [proj.toLowerCase(), proj.toLowerCase().replace(/-/g, " "), proj.toLowerCase().replace(/-/g, "")];
      if (variants.some(v => lower.includes(v))) return proj;
    }
  }
  try {
    const gitConfig = fs.readFileSync(path.join(path.resolve(vaultPath, ".."), ".git", "config"), "utf-8");
    const match = gitConfig.match(/url\s*=\s*.*[/:]([^/\s]+?)(?:\.git)?\s*$/m);
    if (match) return match[1];
  } catch { /* ignore */ }
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(path.resolve(vaultPath, ".."), "package.json"), "utf-8"));
    if (pkg.name) return pkg.name.replace(/^@[^/]+\//, "");
  } catch { /* ignore */ }
  return "default";
}

function sanitizeName(name: string): string {
  return (name.toLowerCase().replace(/[^a-z0-9\-_ ]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "")) || "v";
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Derive phases using LLM (OpenRouter). Falls back to heuristic if no API key or call fails.
 */
async function generatePhasesWithLLM(
  instruction: string,
  mode: PlanningMode,
  codemapSummary: string,
  apiKey: string | undefined
): Promise<{ phases: Array<{ title: string; role: string; harness: string; description: string }>; title: string }> {
  const max = mode === "act" ? 2 : mode === "sketch" ? 3 : 5;

  if (!apiKey) {
    return { phases: derivePhasesFallback(instruction, mode), title: instruction.slice(0, 60) };
  }

  const codeContext = codemapSummary
    ? `\n\nCodebase context:\n${codemapSummary.slice(0, 800)}`
    : "";

  const systemPrompt = `You are a senior software engineering planner. Given an instruction, produce a concise JSON plan.

Return ONLY valid JSON matching this exact shape:
{
  "title": "<5-8 word title for this task>",
  "phases": [
    {
      "title": "<specific, concrete phase title — verb + noun, 4-8 words>",
      "role": "<one of: coder|researcher|qa|planner|devops>",
      "harness": "<one of: claude-code|gemini-cli|any>",
      "description": "<1 sentence of what exactly happens in this phase>"
    }
  ]
}

Rules:
- Produce exactly ${max} phases for "${mode}" mode
- Phase titles MUST be specific to the instruction (not generic like "Implement feature")
- Harness assignment strategy:
  * "gemini-cli" — research, analysis, audit, exploration, documentation, planning phases
  * "claude-code" — implementation, coding, writing tests, refactoring, debugging phases
  * "any" — only for phases that are truly harness-agnostic
- First phase should be research/analysis (gemini-cli) if complexity warrants it
- Last phase should be verification/testing (claude-code)
- No markdown, no extra text — pure JSON only${codeContext}`;

  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/CalvinMagezi/agent-hq",
        "X-Title": "Agent-HQ",
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Instruction: ${instruction}` },
        ],
        temperature: 0.3,
        max_tokens: 800,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) throw new Error(`OpenRouter ${response.status}`);
    const data: any = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim() ?? "";

    // Strip markdown code fences if present
    const jsonStr = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
    const parsed = JSON.parse(jsonStr);

    if (!parsed.phases || !Array.isArray(parsed.phases) || parsed.phases.length === 0) {
      throw new Error("Invalid phases structure");
    }

    return {
      title: parsed.title || instruction.slice(0, 60),
      phases: parsed.phases.slice(0, max).map((p: any) => ({
        title: String(p.title || "Phase"),
        role: ["coder", "researcher", "qa", "planner", "devops"].includes(p.role) ? p.role : "coder",
        harness: ["claude-code", "gemini-cli", "any"].includes(p.harness) ? p.harness : "claude-code",
        description: String(p.description || ""),
      })),
    };
  } catch (err) {
    console.warn("[generatePhasesWithLLM] LLM call failed, using fallback:", err);
    return { phases: derivePhasesFallback(instruction, mode), title: instruction.slice(0, 60) };
  }
}

/**
 * Heuristic phase fallback when LLM is unavailable.
 */
function derivePhasesFallback(instruction: string, mode: PlanningMode): Array<{ title: string; role: string; harness: string; description: string }> {
  const instr = instruction.toLowerCase();
  const max = mode === "act" ? 2 : mode === "sketch" ? 3 : 5;

  const subjectMatch = instr.match(/\b(?:add|create|build|implement|fix|refactor|update|improve|migrate)\s+(?:a\s+|an\s+|the\s+)?([a-z]+(?:\s+[a-z]+){0,3})/i);
  const subject = subjectMatch?.[1] || "implementation";

  const withDesc = (phases: Array<{ title: string; role: string; harness: string }>) =>
    phases.map(p => ({ ...p, description: "" }));

  if (/\bfix\b|\bbug\b|\bpatch\b|\berror\b|\bbroken\b|\bcrash\b/.test(instr)) {
    return withDesc([
      { title: "Identify root cause and trace error", role: "researcher", harness: "gemini-cli" },
      { title: `Fix ${subject}`, role: "coder", harness: "claude-code" },
      { title: "Verify fix and add regression test", role: "qa", harness: "claude-code" },
    ]).slice(0, max);
  }
  if (/\brefactor\b|\bclean\s*up\b|\brewrite\b|\bmigrate\b|\bmodernize\b/.test(instr)) {
    return withDesc([
      { title: "Audit current implementation", role: "researcher", harness: "gemini-cli" },
      { title: `Refactor ${subject}`, role: "coder", harness: "claude-code" },
      { title: "Verify behaviour unchanged", role: "qa", harness: "claude-code" },
      { title: "Update docs and tests", role: "coder", harness: "claude-code" },
    ]).slice(0, max);
  }
  if (/\btest\b|\bspec\b|\bcoverage\b/.test(instr)) {
    return withDesc([
      { title: "Analyse coverage gaps and missing cases", role: "researcher", harness: "gemini-cli" },
      { title: `Write tests for ${subject}`, role: "qa", harness: "claude-code" },
      { title: "Run suite and fix failures", role: "qa", harness: "claude-code" },
    ]).slice(0, max);
  }
  if (/\bdeploy\b|\brelease\b|\bship\b|\bpublish\b/.test(instr)) {
    return withDesc([
      { title: "Review pre-deploy checklist and risks", role: "researcher", harness: "gemini-cli" },
      { title: `Deploy ${subject}`, role: "devops", harness: "claude-code" },
      { title: "Smoke test after deploy", role: "qa", harness: "claude-code" },
    ]).slice(0, max);
  }
  return withDesc([
    { title: "Analyse requirements and codebase", role: "researcher", harness: "gemini-cli" },
    { title: `Implement ${subject}`, role: "coder", harness: "claude-code" },
    { title: "Write tests and verify", role: "qa", harness: "claude-code" },
    { title: "Document changes", role: "coder", harness: "claude-code" },
    { title: "Integration and smoke check", role: "devops", harness: "claude-code" },
  ]).slice(0, max);
}

// Keep derivePhases as a sync alias for internal callers (plan_visualize)
function derivePhases(instruction: string, mode: PlanningMode): Array<{ title: string; role: string; harness: string }> {
  return derivePhasesFallback(instruction, mode);
}

/**
 * Build rich Markdown content for plan.md — phases, questions, mode rationale, next steps.
 */
function generatePlanMarkdown(
  planId: string,
  instruction: string,
  mode: PlanningMode,
  signals: AmbiguitySignal[],
  phases: Array<{ title: string; role: string; harness: string }>,
  patterns: any[]
): string {
  const modeDescriptions: Record<PlanningMode, string> = {
    act: "Simple execution — max 1 clarifying question. No diagrams required.",
    sketch: "Diagram + BDD scenarios — max 3 clarifying questions.",
    blueprint: "Full multi-modal — unlimited questions, screenshots + diagrams + scenarios.",
  };

  const questionLines = signals
    .filter(s => s.suggestedQuestion)
    .map(s => `- [ ] ${s.suggestedQuestion}  _(${s.type}, ${s.severity})_`)
    .join("\n") || "_No clarifying questions needed._";

  const phaseMd = phases.map((p, i) => {
    const num = String(i + 1).padStart(2, "0");
    return `### Phase ${num}: ${p.title}\n- **Role**: \`${p.role}\`\n- **Harness**: \`${p.harness}\`\n- **Status**: pending\n- **Notes**: _add specifics here_\n`;
  }).join("\n");

  const patternsMd = patterns.length > 0
    ? patterns.map(p => `- **${p.title}**: ${p.description}`).join("\n")
    : "_No similar past patterns found. This is a new territory._";

  const artifactsMd = mode === "act"
    ? "- [ ] Code changes applied"
    : mode === "sketch"
    ? "- [ ] Flow diagram (auto-generating on creation)\n- [ ] BDD scenario file"
    : "- [ ] Architecture diagram\n- [ ] Flow diagram\n- [ ] BDD scenarios\n- [ ] Screenshots of affected UI";

  const q1num = signals.some(s => s.suggestedQuestion) ? 1 : null;
  const nextSteps: string[] = [];
  let step = 1;
  if (q1num !== null) {
    nextSteps.push(`${step++}. Answer clarifying questions: \`hq_call plan_answer { "planId": "${planId}", "questionId": N, "answer": "..." }\``);
  }
  nextSteps.push(`${step++}. Edit the **Phases** section above with specific file names, commands, and expected outputs.`);
  if (mode !== "act") {
    nextSteps.push(`${step++}. Generate diagrams: \`hq_call plan_visualize { "planId": "${planId}", "diagramType": "flow" }\``);
    nextSteps.push(`${step++}. Create BDD scenario file and attach: \`hq_call plan_attach { "planId": "${planId}", "type": "scenario", "sourcePath": "...", "label": "..." }\``);
  }
  nextSteps.push(`${step++}. When work is done: \`hq_call plan_update { "planId": "${planId}", "status": "completed", "outcome": "describe what was achieved" }\``);

  const signaledModeReason = signals.length > 0
    ? `\n\n**Why \`${mode}\` was selected:**\n${signals.map(s => `- ${s.description} (\`${s.type}\`, ${s.severity})`).join("\n")}`
    : "";

  return [
    `## Summary`,
    ``,
    `> **${mode}**-level plan | ${phases.length} phases | ${signals.length} ambiguity signal${signals.length !== 1 ? "s" : ""}`,
    `>`,
    `> _${instruction.slice(0, 140)}${instruction.length > 140 ? "..." : ""}_`,
    ``,
    `---`,
    ``,
    `## Planning Mode: \`${mode}\``,
    ``,
    `_${modeDescriptions[mode]}_${signaledModeReason}`,
    ``,
    `---`,
    ``,
    `## Clarifying Questions`,
    ``,
    `_Answer these before executing phases:_`,
    ``,
    questionLines,
    ``,
    `---`,
    ``,
    `## Phases`,
    ``,
    phaseMd,
    `---`,
    ``,
    `## Similar Past Patterns`,
    ``,
    patternsMd,
    ``,
    `---`,
    ``,
    `## Expected Artifacts`,
    ``,
    artifactsMd,
    ``,
    `---`,
    ``,
    `## Next Steps`,
    ``,
    nextSteps.join("\n"),
    ``,
  ].join("\n");
}

/**
 * Generate a simple flow-chart SVG from a list of step titles.
 * Used as a diagram fallback when DrawIt CLI is not installed.
 */
function generateFlowSVG(title: string, steps: string[]): string {
  const W = 320;
  const nodeH = 40;
  const nodeW = 240;
  const gapY = 22;
  const headerH = 44;
  const cx = W / 2;
  const totalH = headerH + steps.length * (nodeH + gapY) + 16;

  const nodes = steps.map((step, i) => {
    const nodeY = headerH + i * (nodeH + gapY);
    const arrow = i > 0
      ? `<line x1="${cx}" y1="${nodeY - gapY + 2}" x2="${cx}" y2="${nodeY - 4}" stroke="#3b82f6" stroke-width="1.5" marker-end="url(#arr)"/>`
      : "";
    return [
      arrow,
      `<rect x="${cx - nodeW / 2}" y="${nodeY}" width="${nodeW}" height="${nodeH}" rx="7" fill="rgba(59,130,246,0.1)" stroke="#3b82f6" stroke-width="1.2"/>`,
      `<text x="${cx}" y="${nodeY + 25}" text-anchor="middle" fill="#e2e8f0" font-family="JetBrains Mono, monospace" font-size="10.5">${escapeXml(step.slice(0, 34))}</text>`,
    ].join("\n    ");
  }).join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${totalH}" viewBox="0 0 ${W} ${totalH}">
  <defs>
    <marker id="arr" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
      <path d="M0,0 L0,6 L6,3 z" fill="#3b82f6"/>
    </marker>
  </defs>
  <rect width="${W}" height="${totalH}" fill="#0d1526" rx="10"/>
  <text x="${cx}" y="27" text-anchor="middle" fill="#94a3b8" font-family="JetBrains Mono, monospace" font-size="11" font-weight="600">${escapeXml(title.slice(0, 44))}</text>
  ${nodes}
</svg>`;
}

/**
 * Update plan.md frontmatter with new values.
 * Safe no-op if the file doesn't exist.
 */
function syncPlanFile(plansDir: string, planId: string, updates: Record<string, any>): void {
  const planFile = path.join(plansDir, planId, "plan.md");
  if (!fs.existsSync(planFile)) return;
  try {
    const raw = fs.readFileSync(planFile, "utf-8");
    const file = matter(raw);
    const newData = { ...file.data, ...updates, updatedAt: new Date().toISOString() };
    fs.writeFileSync(planFile, matter.stringify(file.content, newData));
  } catch (err) {
    console.warn(`[syncPlanFile] Failed to sync ${planId}:`, err);
  }
}

/**
 * Ensure plan folder and all asset subdirs exist.
 * Returns plan folder path.
 */
function ensurePlanFolder(vaultPath: string, planId: string): string {
  const dir = path.join(vaultPath, "_plans", "active", planId);
  fs.mkdirSync(path.join(dir, "assets", "screenshots"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets", "diagrams"), { recursive: true });
  fs.mkdirSync(path.join(dir, "assets", "scenarios"), { recursive: true });

  // Migrate flat file if present
  const oldFlat = path.join(vaultPath, "_plans", "active", `${planId}.md`);
  const newPlanFile = path.join(dir, "plan.md");
  if (fs.existsSync(oldFlat) && !fs.existsSync(newPlanFile)) {
    fs.renameSync(oldFlat, newPlanFile);
  }

  return dir;
}

/**
 * Write or update manifest.json inside the plan folder.
 */
function readManifest(plansDir: string, planId: string, plan: any): PlanManifest {
  const mf = path.join(plansDir, planId, "manifest.json");
  if (fs.existsSync(mf)) {
    try { return JSON.parse(fs.readFileSync(mf, "utf-8")); } catch { /* fall through */ }
  }
  return {
    planId,
    version: 1,
    planningMode: plan.planning_mode || "sketch",
    ambiguitySignals: plan.ambiguity_signals || [],
    assets: [],
    createdAt: plan.created_at || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function writeManifest(plansDir: string, planId: string, manifest: PlanManifest): void {
  fs.writeFileSync(path.join(plansDir, planId, "manifest.json"), JSON.stringify(manifest, null, 2));
}

/**
 * Try to auto-generate a flow diagram for the plan.
 * Attempts DrawIt first, falls back to a pure-SVG implementation.
 * Never throws — failures are logged and silently skipped.
 */
async function tryAutoVisualize(
  planId: string,
  instruction: string,
  phases: Array<{ title: string }>,
  plansDir: string,
  db: any,
  ctx: HQContext
): Promise<void> {
  const steps = phases.length > 0 ? phases.map(p => p.title) : [instruction.slice(0, 34)];
  const diagramTitle = `${planId}-flow`;
  const targetDir = path.join(plansDir, planId, "assets", "diagrams");
  let svgContent: string | null = null;
  let ext = ".svg";

  // 1. Try DrawIt pipeline
  try {
    const ndjson = buildStructuredDiagram({
      title: diagramTitle,
      nodes: steps,
      edges: steps.slice(0, -1).map((s, i) => `${s}>${steps[i + 1]}`),
    });
    const result = await renderPipeline(diagramTitle, ndjson, ctx, { folder: "tmp-plan-diagrams", svgOnly: true });
    const svgSrc = result.svgPath;
    if (svgSrc && fs.existsSync(svgSrc)) {
      const destPath = path.join(targetDir, `flow.svg`);
      fs.renameSync(svgSrc, destPath);
      // Register asset
      const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const relPath = "assets/diagrams/flow.svg";
      addPlanAsset(db, {
        id: assetId, plan_id: planId, asset_type: "diagram",
        filename: relPath, label: "Auto-generated flow diagram",
        source_tool: "plan_create", size_bytes: fs.statSync(destPath).size,
        created_at: new Date().toISOString(),
      });
      return;
    }
  } catch { /* DrawIt not installed or failed — fall through to SVG fallback */ }

  // 2. SVG fallback — zero external dependencies
  try {
    svgContent = generateFlowSVG(instruction.slice(0, 44), steps);
    const destPath = path.join(targetDir, `flow.svg`);
    fs.writeFileSync(destPath, svgContent, "utf-8");
    const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const relPath = "assets/diagrams/flow.svg";
    addPlanAsset(db, {
      id: assetId, plan_id: planId, asset_type: "diagram",
      filename: relPath, label: "Auto-generated flow diagram (SVG fallback)",
      source_tool: "plan_create", size_bytes: Buffer.byteLength(svgContent),
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    console.warn(`[tryAutoVisualize] SVG fallback also failed for ${planId}:`, err);
  }
}

// ── 1. plan_create ─────────────────────────────────────────────────

export const PlanCreateTool: HQTool<
  { instruction: string; project?: string; mode?: PlanningMode },
  any
> = {
  name: "plan_create",
  description: "Create a new cross-agent plan. Generates a structured folder with plan.md, phases, clarifying questions, and an initial flow diagram.",
  tags: ["plan", "create", "architecture", "delegation"],
  requiresWriteAccess: true,
  schema: Type.Object({
    instruction: Type.String({ description: "High-level goal or instruction for the plan." }),
    project: Type.Optional(Type.String({ description: "Project name. Auto-detected if omitted." })),
    mode: Type.Optional(
      Type.Union([Type.Literal("act"), Type.Literal("sketch"), Type.Literal("blueprint")], {
        description: "Planning depth. Auto-detected from instruction ambiguity if omitted.",
      })
    ),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const knowledge = new PlanKnowledgeEngine(db);
    const codemap = new CodemapEngine(db);

    const project = input.project || detectProject(input.instruction, ctx.vaultPath);
    const planId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    const similarPatterns = await knowledge.findSimilarPatterns(input.instruction, project);
    const codemapSummary = codemap.getSummary(project);

    // Detect ambiguity and select mode
    const report = detectAmbiguity(input.instruction, codemapSummary, project);
    const planningMode: PlanningMode = input.mode ?? getPlanningMode(report.score);
    const modeConfig = MODE_CONFIGS[planningMode];

    // Generate phases with LLM (falls back to heuristic if no API key)
    const { phases: derivedPhases, title: llmTitle } = await generatePhasesWithLLM(
      input.instruction,
      planningMode,
      codemapSummary,
      ctx.openrouterApiKey
    );
    const dbPhases: PlanPhase[] = derivedPhases.map((p, i) => ({
      phaseId: `phase-${i + 1}`,
      title: p.title,
      harness: p.harness,
      role: p.role,
      status: "pending",
    }));

    const planTitle = llmTitle || input.instruction.slice(0, 100);

    // Persist to DB first
    upsertPlan(db, {
      id: planId,
      project,
      title: planTitle,
      status: "delegated",
      instruction: input.instruction,
      phases: dbPhases,
      planning_mode: planningMode,
      ambiguity_signals: report.signals,
    });

    // Create folder structure
    const plansBaseDir = path.join(ctx.vaultPath, "_plans", "active");
    const planDir = ensurePlanFolder(ctx.vaultPath, planId);

    // Write rich plan.md
    const planBody = generatePlanMarkdown(planId, input.instruction, planningMode, report.signals, derivedPhases, similarPatterns.slice(0, 3));
    const planFrontmatter = {
      planId,
      title: planTitle,
      project,
      status: "delegated",
      planningMode,
      ambiguityScore: Math.round(report.score * 100) / 100,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(path.join(planDir, "plan.md"), matter.stringify(planBody, planFrontmatter));

    // Write manifest
    const manifest: PlanManifest = {
      planId, version: 1, planningMode,
      ambiguitySignals: report.signals, assets: [],
      createdAt: now, updatedAt: now,
    };
    writeManifest(plansBaseDir, planId, manifest);

    // Auto-generate initial flow diagram for sketch/blueprint
    if (modeConfig.diagrams) {
      await tryAutoVisualize(planId, input.instruction, derivedPhases, plansBaseDir, db, ctx);
      // Bump manifest version if a diagram was added
      const assets = getPlanAssets(db, planId);
      if (assets.length > 0) {
        const updated = readManifest(plansBaseDir, planId, { planning_mode: planningMode, ambiguity_signals: report.signals, created_at: now });
        updated.assets = assets.map(({ plan_id: _, ...a }) => a);
        updated.version = 2;
        updated.updatedAt = now;
        writeManifest(plansBaseDir, planId, updated);
      }
    }

    // Create delegation job with explicit agent instructions
    fs.mkdirSync(path.join(ctx.vaultPath, "_jobs", "pending"), { recursive: true });
    const jobPath = path.join(ctx.vaultPath, "_jobs", "pending", `${planId}-delegation.md`);
    const jobFrontmatter = {
      jobId: `${planId}-delegation`,
      planId,
      type: "background",
      status: "pending",
      role: "planner",
      priority: 80,
      securityProfile: "STANDARD",
      createdAt: now,
    };
    const jobBody = buildDelegationJobBody(planId, planTitle, input.instruction, planningMode, modeConfig, derivedPhases, report.signals, similarPatterns, codemapSummary);
    fs.writeFileSync(jobPath, matter.stringify(jobBody, jobFrontmatter));

    const assets = getPlanAssets(db, planId);

    return {
      planId,
      title: planTitle,
      status: "delegated",
      planningMode,
      ambiguityScore: report.score,
      ambiguitySignals: report.signals,
      phases: dbPhases,
      autoGeneratedDiagram: assets.length > 0,
      planFolder: `_plans/active/${planId}/`,
      delegationJobCreated: true,
      message: `Plan created. HQ agent will pick up the delegation job and dispatch ${dbPhases.length} phases to relay agents.`,
      nextSteps: buildNextStepsHint(planId, planningMode, report.signals),
    };
  },
};

/**
 * Build the delegation job body.
 * Instructs the HQ agent to:
 *   1. Mark the plan in_progress
 *   2. Dispatch each phase as a real relay delegation task
 *   3. Report back with plan_phase_update as phases complete
 */
function buildDelegationJobBody(
  planId: string,
  planTitle: string,
  instruction: string,
  mode: PlanningMode,
  modeConfig: any,
  phases: Array<{ title: string; role: string; harness: string; description?: string }>,
  signals: AmbiguitySignal[],
  patterns: any[],
  codemapSummary: string,
): string {
  const signalBlock = signals.length > 0
    ? `### Ambiguity Signals\n${signals.map(s => `- **${s.type}** (${s.severity}): ${s.description}${s.suggestedQuestion ? `\n  > Q: ${s.suggestedQuestion}` : ""}`).join("\n")}`
    : "### Ambiguity Signals\n_None detected._";

  const phaseDelegationBlocks = phases.map((p, i) => {
    const phaseId = `phase-${i + 1}`;
    const taskInstruction = [
      `## Phase ${i + 1}: ${p.title}`,
      ``,
      `**Parent plan**: ${planId}`,
      `**Phase ID**: ${phaseId}`,
      `**Role**: ${p.role}`,
      ``,
      `### Task`,
      p.description ? p.description : instruction,
      ``,
      `### Full Instruction`,
      instruction,
      ``,
      `### On Completion`,
      `Call \`hq_call plan_phase_update { "planId": "${planId}", "phaseId": "${phaseId}", "status": "completed", "notes": "..." }\``,
    ].join("\n");

    return `### Delegate Phase ${i + 1}: ${p.title}
\`\`\`
delegate_to_relay {
  "tasks": [{
    "taskId": "${planId}-${phaseId}",
    "targetHarnessType": "${p.harness}",
    "instruction": ${JSON.stringify(taskInstruction)},
    "priority": 75
  }]
}
\`\`\``;
  }).join("\n\n");

  const patternsBlock = patterns.length > 0
    ? `### Similar Past Patterns\n${patterns.slice(0, 3).map(p => `- **${p.title}**: ${p.description}`).join("\n")}`
    : "### Similar Past Patterns\n_None._";

  return [
    `# Plan Execution: ${planTitle}`,
    ``,
    `**Plan ID**: ${planId}  `,
    `**Mode**: \`${mode}\` (${phases.length} phases)`,
    ``,
    `## Instruction`,
    ``,
    instruction,
    ``,
    `## Your Job`,
    ``,
    `Execute this plan by delegating each phase to the appropriate relay harness.`,
    `Complete the steps below in order.`,
    ``,
    `## Step 1: Mark plan as active`,
    ``,
    `\`\`\``,
    `hq_call plan_update { "planId": "${planId}", "status": "in_progress" }`,
    `\`\`\``,
    ``,
    `## Step 2: Delegate phases to relay agents`,
    ``,
    `Use \`delegate_to_relay\` for each phase. Each phase task should call \`plan_phase_update\` when done.`,
    ``,
    phaseDelegationBlocks,
    ``,
    `## Step 3: Wait for all phases`,
    ``,
    `Use \`check_delegation_status\` to monitor progress. Once all phases report back as completed,`,
    `the plan will auto-complete. If all phases finish, call:`,
    ``,
    `\`\`\``,
    `hq_call plan_update { "planId": "${planId}", "status": "completed", "outcome": "All ${phases.length} phases executed successfully." }`,
    `\`\`\``,
    ``,
    signalBlock,
    ``,
    patternsBlock,
    ``,
    `### Codebase Summary`,
    codemapSummary.slice(0, 1200) || "_No codemap yet._",
  ].join("\n");
}

function buildNextStepsHint(planId: string, mode: PlanningMode, signals: AmbiguitySignal[]): string[] {
  const steps: string[] = [];
  if (signals.some(s => s.suggestedQuestion)) {
    steps.push(`Answer clarifying questions (${signals.filter(s => s.suggestedQuestion).length} pending)`);
  }
  steps.push(`Review phases in _plans/active/${planId}/plan.md`);
  if (mode !== "act") {
    steps.push(`Add diagrams: hq_call plan_visualize { "planId": "${planId}", "diagramType": "architecture" }`);
  }
  steps.push(`Mark done: hq_call plan_update { "planId": "${planId}", "status": "completed", "outcome": "..." }`);
  return steps;
}

// ── 2. plan_status ─────────────────────────────────────────────────

export const PlanStatusTool: HQTool<{ planId: string }, any> = {
  name: "plan_status",
  description: "Get current status, phases, asset counts, and ambiguity signals for a plan.",
  tags: ["plan", "status", "progress"],
  schema: Type.Object({
    planId: Type.String({ description: "Plan ID (e.g. plan-1741...)" }),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const questions = getPendingQuestions(db, input.planId);
    const assets = getPlanAssets(db, input.planId);

    // Also read plan.md for latest content if it exists
    const planDir = path.join(ctx.vaultPath, "_plans", "active", input.planId);
    let fileStatus: string | undefined;
    if (fs.existsSync(path.join(planDir, "plan.md"))) {
      try {
        const raw = fs.readFileSync(path.join(planDir, "plan.md"), "utf-8");
        fileStatus = matter(raw).data?.status;
      } catch { /* ignore */ }
    }

    return {
      planId: plan.id,
      status: fileStatus || plan.status,
      title: plan.title,
      planningMode: plan.planning_mode,
      project: plan.project,
      assetCount: assets.length,
      assetSummary: {
        screenshots: assets.filter(a => a.asset_type === "screenshot").length,
        diagrams: assets.filter(a => a.asset_type === "diagram").length,
        scenarios: assets.filter(a => a.asset_type === "scenario").length,
      },
      ambiguitySignals: plan.ambiguity_signals,
      phases: plan.phases,
      pendingQuestions: questions.map(q => ({
        id: q.id,
        question: q.question,
        askedBy: q.asked_by,
        context: q.context,
      })),
      planFolder: `_plans/active/${input.planId}/`,
      updatedAt: plan.updated_at,
    };
  },
};

// ── 3. plan_answer ─────────────────────────────────────────────────

export const PlanAnswerTool: HQTool<{ planId: string; questionId: number; answer: string }, any> = {
  name: "plan_answer",
  description: "Answer a clarifying question in a plan.",
  tags: ["plan", "answer"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String(),
    questionId: Type.Number(),
    answer: Type.String(),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);
    answerQuestion(db, input.planId, input.questionId, input.answer);
    const remaining = getPendingQuestions(db, input.planId);
    return { acknowledged: true, remainingQuestions: remaining.length };
  },
};

// ── 4. plan_search ─────────────────────────────────────────────────

export const PlanSearchTool: HQTool<{ query: string; project?: string }, any> = {
  name: "plan_search",
  description: "Search past plans and reusable patterns.",
  tags: ["plan", "search", "patterns"],
  schema: Type.Object({
    query: Type.String(),
    project: Type.Optional(Type.String()),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    let plans: any[] = [];
    let patterns: any[] = [];
    try { plans = searchPlans(db, input.query, input.project); } catch { /* FTS5 table empty */ }
    try { patterns = searchPatterns(db, input.query, input.project); } catch { /* FTS5 table empty */ }
    return {
      plans: plans.slice(0, 5).map(p => ({ id: p.id, title: p.title, status: p.status, planningMode: p.planning_mode })),
      patterns: patterns.slice(0, 5).map(p => ({ title: p.title, description: p.description, approach: p.approach })),
    };
  },
};

// ── 5. plan_update ─────────────────────────────────────────────────

export const PlanUpdateTool: HQTool<{
  planId: string;
  status?: string;
  outcome?: string;
  phasesUpdate?: any[];
  filesTouched?: string[];
}, any> = {
  name: "plan_update",
  description: "Update plan status, outcome, or phases. Also syncs plan.md frontmatter so the file and DB stay consistent.",
  tags: ["plan", "update", "completion"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String(),
    status: Type.Optional(Type.String()),
    outcome: Type.Optional(Type.String()),
    phasesUpdate: Type.Optional(Type.Array(Type.Any())),
    filesTouched: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const dbUpdates: any = { id: input.planId };
    if (input.status) dbUpdates.status = input.status;
    if (input.outcome) dbUpdates.outcome = input.outcome;
    if (input.phasesUpdate) dbUpdates.phases = input.phasesUpdate;
    if (input.filesTouched) dbUpdates.files_touched = input.filesTouched;
    if (input.status === "completed") dbUpdates.completed_at = new Date().toISOString();

    // If any update is made and plan is still "delegated", promote to "in_progress"
    if (!input.status && plan.status === "delegated") {
      dbUpdates.status = "in_progress";
    }

    upsertPlan(db, dbUpdates);

    // Sync plan.md frontmatter
    const plansBaseDir = path.join(ctx.vaultPath, "_plans", "active");
    const fileUpdates: Record<string, any> = {};
    if (dbUpdates.status) fileUpdates.status = dbUpdates.status;
    if (input.outcome) fileUpdates.outcome = input.outcome;
    if (dbUpdates.completed_at) fileUpdates.completedAt = dbUpdates.completed_at;
    if (Object.keys(fileUpdates).length > 0) {
      syncPlanFile(plansBaseDir, input.planId, fileUpdates);
    }

    return { updated: true, newStatus: dbUpdates.status || plan.status };
  },
};

// ── 6. codemap_query ─────────────────────────────────────────────────

export const CodemapQueryTool: HQTool<{
  project: string;
  query?: string;
  filePatterns?: string[];
}, any> = {
  name: "codemap_query",
  description: "Query the progressive codebase understanding for a project (token-efficient).",
  tags: ["codemap", "context", "codebase"],
  schema: Type.Object({
    project: Type.String(),
    query: Type.Optional(Type.String()),
    filePatterns: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const codemap = new CodemapEngine(db);
    const summary = codemap.getSummary(input.project);
    let entries = getCodemapForProject(db, input.project);
    const conventions = getConventionsForProject(db, input.project);

    if (input.query) {
      const q = input.query.toLowerCase();
      entries = entries.filter(e =>
        (e.purpose && e.purpose.toLowerCase().includes(q)) ||
        e.file_path.toLowerCase().includes(q) ||
        e.key_exports.some(exp => exp.name.toLowerCase().includes(q))
      );
    }
    if (input.filePatterns?.length) {
      entries = entries.filter(e => input.filePatterns!.some(p => e.file_path.includes(p)));
    }

    return {
      summary,
      files: entries.filter(e => e.confidence > 0.3).slice(0, 20),
      conventions,
      mappedFiles: getCodemapForProject(db, input.project).length,
    };
  },
};

// ── 7. codemap_update ─────────────────────────────────────────────────

export const CodemapUpdateTool: HQTool<{
  project: string;
  entries: Array<{ file_path: string; purpose?: string; key_exports?: any[]; patterns?: string[] }>;
}, any> = {
  name: "codemap_update",
  description: "Record codebase observations — agents call this after exploring files to grow the codemap.",
  tags: ["codemap", "update", "observe"],
  requiresWriteAccess: true,
  schema: Type.Object({
    project: Type.String(),
    entries: Type.Array(Type.Object({
      file_path: Type.String(),
      purpose: Type.Optional(Type.String()),
      key_exports: Type.Optional(Type.Array(Type.Object({ name: Type.String(), type: Type.String(), line: Type.Optional(Type.Number()) }))),
      patterns: Type.Optional(Type.Array(Type.String())),
    })),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const codemap = new CodemapEngine(db);
    let updated = 0;
    for (const entry of input.entries.slice(0, 50)) {
      await codemap.observeFile(input.project, entry.file_path, {
        purpose: entry.purpose,
        key_exports: entry.key_exports || [],
        patterns: entry.patterns || [],
      });
      updated++;
    }
    return { updated, project: input.project };
  },
};

// ── 8. plan_attach ─────────────────────────────────────────────────

export const PlanAttachTool: HQTool<{
  planId: string;
  type: "screenshot" | "diagram" | "scenario";
  sourcePath: string;
  label: string;
  phaseId?: string;
}, any> = {
  name: "plan_attach",
  description: "Attach an asset (screenshot, diagram, scenario file) to a plan folder.",
  tags: ["plan", "attach", "asset"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String(),
    type: Type.Union([Type.Literal("screenshot"), Type.Literal("diagram"), Type.Literal("scenario")]),
    sourcePath: Type.String({ description: "Absolute path to the file to attach." }),
    label: Type.String({ description: "Human-readable label for this asset." }),
    phaseId: Type.Optional(Type.String()),
  }),
  async execute(input, ctx) {
    // Validate source
    if (!fs.existsSync(input.sourcePath)) {
      throw new Error(`Source file not found: ${input.sourcePath}`);
    }

    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const plansBaseDir = path.join(ctx.vaultPath, "_plans", "active");
    const planDir = ensurePlanFolder(ctx.vaultPath, input.planId);
    const assetSubdir = `assets/${input.type}s`;

    // Handle filename collisions by appending a counter
    const origBasename = path.basename(input.sourcePath);
    const ext = path.extname(origBasename);
    const base = path.basename(origBasename, ext);
    let destFilename = origBasename;
    let counter = 1;
    while (fs.existsSync(path.join(planDir, assetSubdir, destFilename))) {
      destFilename = `${base}-${counter}${ext}`;
      counter++;
    }

    const relPath = `${assetSubdir}/${destFilename}`;
    const destPath = path.join(planDir, relPath);
    fs.copyFileSync(input.sourcePath, destPath);

    const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sizeBytes = fs.statSync(destPath).size;
    const createdAt = new Date().toISOString();

    addPlanAsset(db, {
      id: assetId,
      plan_id: input.planId,
      asset_type: input.type,
      filename: relPath,
      label: input.label,
      phase_id: input.phaseId,
      source_tool: "plan_attach",
      size_bytes: sizeBytes,
      created_at: createdAt,
    });

    // Update manifest
    const manifest = readManifest(plansBaseDir, input.planId, plan);
    manifest.version++;
    manifest.updatedAt = createdAt;
    manifest.assets.push({
      id: assetId,
      asset_type: input.type,
      filename: relPath,
      label: input.label,
      phase_id: input.phaseId,
      source_tool: "plan_attach",
      size_bytes: sizeBytes,
      created_at: createdAt,
    });
    writeManifest(plansBaseDir, input.planId, manifest);

    // Auto-promote status if still delegated
    if (plan.status === "delegated") {
      upsertPlan(db, { id: input.planId, status: "in_progress" });
      syncPlanFile(plansBaseDir, input.planId, { status: "in_progress" });
    }

    return { assetId, relativePath: relPath, manifestVersion: manifest.version };
  },
};

// ── 9. plan_visualize ───────────────────────────────────────────────

export const PlanVisualizeTool: HQTool<{
  planId: string;
  diagramType: "architecture" | "flow" | "sequence" | "dependency";
  title?: string;
  description?: string;
}, any> = {
  name: "plan_visualize",
  description: "Generate a diagram for a plan (flow, architecture, sequence, dependency). Falls back to SVG if DrawIt CLI is unavailable.",
  tags: ["plan", "visualize", "diagram"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String(),
    diagramType: Type.Union([
      Type.Literal("architecture"),
      Type.Literal("flow"),
      Type.Literal("sequence"),
      Type.Literal("dependency"),
    ]),
    title: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    const plansBaseDir = path.join(ctx.vaultPath, "_plans", "active");
    const planDir = ensurePlanFolder(ctx.vaultPath, input.planId);
    const targetDir = path.join(planDir, "assets", "diagrams");

    // Build node list from plan phases or files_touched
    let steps: string[];
    if (input.diagramType === "dependency") {
      steps = plan.files_touched.length > 0
        ? plan.files_touched.slice(0, 12).map(f => path.basename(f))
        : ["(no files recorded yet)"];
    } else {
      steps = plan.phases.length > 0
        ? plan.phases.map(p => p.title)
        : derivePhases(plan.instruction, plan.planning_mode).map(p => p.title);
    }

    const diagramTitle = input.title || `${input.planId}-${input.diagramType}`;
    const safeName = sanitizeName(diagramTitle);
    let finalPath: string;
    let usedFallback = false;

    // Try DrawIt first
    try {
      const ndjson = buildStructuredDiagram({
        title: diagramTitle,
        nodes: steps,
        edges: steps.slice(0, -1).map((s, i) => `${s}>${steps[i + 1]}`),
      });
      const result = await renderPipeline(diagramTitle, ndjson, ctx, {
        folder: "tmp-plan-diagrams",
        svgOnly: true,
      });
      const source = result.pngPath || result.svgPath;
      if (!source || !fs.existsSync(source)) throw new Error("renderPipeline returned no output file");
      const ext = result.pngPath ? ".png" : ".svg";
      finalPath = path.join(targetDir, `${safeName}${ext}`);
      fs.renameSync(source, finalPath);
    } catch {
      // Fallback: generate SVG directly
      usedFallback = true;
      const svgContent = generateFlowSVG(diagramTitle, steps);
      finalPath = path.join(targetDir, `${safeName}.svg`);
      fs.writeFileSync(finalPath, svgContent, "utf-8");
    }

    const relPath = `assets/diagrams/${path.basename(finalPath)}`;
    const sizeBytes = fs.statSync(finalPath).size;
    const assetId = `asset-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = new Date().toISOString();

    addPlanAsset(db, {
      id: assetId,
      plan_id: input.planId,
      asset_type: "diagram",
      filename: relPath,
      label: input.title || `${input.diagramType} diagram${usedFallback ? " (SVG)" : ""}`,
      source_tool: "plan_visualize",
      size_bytes: sizeBytes,
      created_at: createdAt,
    });

    // Update manifest
    const manifest = readManifest(plansBaseDir, input.planId, plan);
    manifest.version++;
    manifest.updatedAt = createdAt;
    manifest.assets.push({
      id: assetId,
      asset_type: "diagram",
      filename: relPath,
      label: input.title || `${input.diagramType} diagram`,
      source_tool: "plan_visualize",
      size_bytes: sizeBytes,
      created_at: createdAt,
    });
    writeManifest(plansBaseDir, input.planId, manifest);

    // Auto-promote status
    if (plan.status === "delegated") {
      upsertPlan(db, { id: input.planId, status: "in_progress" });
      syncPlanFile(plansBaseDir, input.planId, { status: "in_progress" });
    }

    return {
      assetId,
      diagramPath: relPath,
      displayName: path.basename(finalPath),
      usedFallback,
    };
  },
};

// ── 10. plan_phase_update ──────────────────────────────────────────

export const PlanPhaseUpdateTool: HQTool<{
  planId: string;
  phaseId: string;
  status: "in_progress" | "completed" | "failed" | "skipped";
  notes?: string;
}, any> = {
  name: "plan_phase_update",
  description: "Mark a specific phase of a plan as in_progress, completed, failed, or skipped. Auto-completes the plan when all phases are done.",
  tags: ["plan", "phase", "update", "progress"],
  requiresWriteAccess: true,
  schema: Type.Object({
    planId: Type.String({ description: "Plan ID" }),
    phaseId: Type.String({ description: "Phase ID (e.g. phase-1, phase-2)" }),
    status: Type.Union([
      Type.Literal("in_progress"),
      Type.Literal("completed"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
    notes: Type.Optional(Type.String({ description: "What was done or why it failed." })),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    const plan = getPlan(db, input.planId);
    if (!plan) throw new Error(`Plan not found: ${input.planId}`);

    // Update the phase in the phases array
    const updatedPhases = plan.phases.map(p =>
      p.phaseId === input.phaseId
        ? { ...p, status: input.status, notes: input.notes || p.notes }
        : p
    );

    if (!updatedPhases.find(p => p.phaseId === input.phaseId)) {
      throw new Error(`Phase not found: ${input.phaseId} in plan ${input.planId}`);
    }

    // Auto-promote plan to in_progress when first phase starts
    let planStatus = plan.status;
    if (input.status === "in_progress" && plan.status === "delegated") {
      planStatus = "in_progress";
    }

    // Auto-complete plan when all phases are terminal
    const terminalPhaseStatuses = ["completed", "failed", "skipped"];
    const allDone = updatedPhases.every(p => terminalPhaseStatuses.includes(p.status));
    const anyFailed = updatedPhases.some(p => p.status === "failed");
    if (allDone) {
      planStatus = anyFailed ? "failed" : "completed";
    }

    upsertPlan(db, {
      id: input.planId,
      phases: updatedPhases,
      status: planStatus,
      ...(planStatus === "completed" && { completed_at: new Date().toISOString() }),
    });

    // Sync plan.md — update phase status line and plan status
    const plansBaseDir = path.join(ctx.vaultPath, "_plans", "active");
    const planFile = path.join(plansBaseDir, input.planId, "plan.md");
    if (fs.existsSync(planFile)) {
      try {
        const raw = fs.readFileSync(planFile, "utf-8");
        const file = matter(raw);
        const fileUpdates: Record<string, any> = {
          status: planStatus,
          updatedAt: new Date().toISOString(),
        };
        if (planStatus === "completed") fileUpdates.completedAt = new Date().toISOString();

        // Update phase status line in markdown body
        const phaseNum = input.phaseId.replace("phase-", "");
        let newContent = file.content.replace(
          new RegExp(`(### Phase ${phaseNum}:[^\\n]*)([\\s\\S]*?- \\*\\*Status\\*\\*: )\\w+`),
          `$1$2${input.status}`
        );
        if (input.notes) {
          newContent = newContent.replace(
            new RegExp(`(### Phase ${phaseNum}:[^\\n]*[\\s\\S]*?- \\*\\*Notes\\*\\*: )_[^\\n]*_`),
            `$1${input.notes}`
          );
        }

        fs.writeFileSync(planFile, matter.stringify(newContent, { ...file.data, ...fileUpdates }));
      } catch (err) {
        console.warn(`[plan_phase_update] Failed to update plan.md for ${input.planId}:`, err);
      }
    }

    const completedCount = updatedPhases.filter(p => p.status === "completed").length;
    const totalPhases = updatedPhases.length;

    return {
      updated: true,
      phaseId: input.phaseId,
      phaseStatus: input.status,
      planStatus,
      progress: `${completedCount}/${totalPhases} phases completed`,
      autoCompleted: allDone,
    };
  },
};

// ── 11. plan_gallery ───────────────────────────────────────────────

export const PlanGalleryTool: HQTool<{
  planId: string;
  type?: "screenshot" | "diagram" | "scenario";
}, any> = {
  name: "plan_gallery",
  description: "List all assets attached to a plan, with counts by type.",
  tags: ["plan", "gallery", "assets"],
  schema: Type.Object({
    planId: Type.String(),
    type: Type.Optional(Type.Union([
      Type.Literal("screenshot"),
      Type.Literal("diagram"),
      Type.Literal("scenario"),
    ])),
  }),
  async execute(input, ctx) {
    const db = getPlanDB(ctx);
    if (!getPlan(db, input.planId)) throw new Error(`Plan not found: ${input.planId}`);

    const assets = getPlanAssets(db, input.planId, input.type);
    const all = getPlanAssets(db, input.planId);

    return {
      assets,
      totalCount: assets.length,
      byType: {
        screenshots: all.filter(a => a.asset_type === "screenshot").length,
        diagrams: all.filter(a => a.asset_type === "diagram").length,
        scenarios: all.filter(a => a.asset_type === "scenario").length,
      },
      planFolder: `_plans/active/${input.planId}/`,
    };
  },
};
