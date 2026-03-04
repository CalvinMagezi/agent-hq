/**
 * DrawIt HQ Tools
 *
 * Thin wrappers around the Chamuka DrawIt CLI for diagram generation,
 * export, and analysis. Provides a fast pipeline:
 *   generate NDJSON → export SVG → convert PNG → [FILE:] marker for sharing
 *
 * Requires: `drawit` CLI installed (npm i -g @chamuka-labs/drawit-cli)
 * PNG conversion: @resvg/resvg-js (Rust-based, no system deps)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execSync } from "child_process";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the drawit CLI binary path */
function findDrawItBin(): string {
  try {
    return execSync("which drawit", { encoding: "utf-8" }).trim();
  } catch {
    // Homebrew default on macOS
    const fallback = "/opt/homebrew/bin/drawit";
    if (fs.existsSync(fallback)) return fallback;
    throw new Error(
      "DrawIt CLI not found. Install it: npm i -g @chamuka-labs/drawit-cli"
    );
  }
}

/** Run a drawit CLI command and return stdout */
function runDrawIt(args: string[], timeoutMs = 30_000): string {
  const bin = findDrawItBin();
  const cmd = `"${bin}" ${args.map((a) => `"${a}"`).join(" ")}`;
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (err: any) {
    const stderr = err.stderr?.toString()?.trim() ?? "";
    throw new Error(`drawit failed: ${stderr || err.message}`);
  }
}

/** Ensure the Diagrams folder exists and return its path */
function ensureDiagramsDir(vaultPath: string, subfolder?: string): string {
  const base = path.join(vaultPath, "Notebooks", "Diagrams");
  const dir = subfolder ? path.join(base, subfolder) : base;
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Generate a unique output path in _jobs/outputs/ */
function outputPath(vaultPath: string, ext: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(Date.now().toString() + Math.random().toString())
    .digest("hex")
    .slice(0, 8);
  const dir = path.join(vaultPath, "_jobs", "outputs");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `diagram-${Date.now()}-${hash}.${ext}`);
}

/** Sanitize a name into a safe filename */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "diagram";
}

/** Convert SVG content to PNG bytes using resvg */
async function svgToPng(
  svgContent: string,
  width?: number
): Promise<Uint8Array> {
  // Dynamic import to avoid issues if the native binary isn't available
  const { Resvg } = await import("@resvg/resvg-js");
  const opts: any = {};
  if (width) {
    opts.fitTo = { mode: "width", value: width };
  }
  const resvg = new Resvg(svgContent, opts);
  const pngData = resvg.render();
  return pngData.asPng();
}

/** Export a .drawit file to SVG, returning the SVG file path */
function exportToSvg(
  drawItPath: string,
  vaultPath: string,
  padding = 20
): string {
  const svgPath = outputPath(vaultPath, "svg");
  runDrawIt([
    "export",
    drawItPath,
    "--format",
    "svg",
    "--output",
    svgPath,
    "--padding",
    String(padding),
  ]);
  return svgPath;
}

/** Full pipeline: save NDJSON → export SVG → convert PNG */
async function renderPipeline(
  name: string,
  content: string,
  ctx: HQContext,
  opts: { folder?: string; svgOnly?: boolean; padding?: number }
): Promise<{
  drawitPath: string;
  svgPath: string;
  pngPath?: string;
  displayName: string;
}> {
  // 1. Save .drawit file
  const dir = ensureDiagramsDir(ctx.vaultPath, opts.folder);
  const safeName = sanitizeName(name);
  const drawitPath = path.join(dir, `${safeName}.drawit`);
  fs.writeFileSync(drawitPath, content, "utf-8");

  // 2. Export to SVG
  const svgPath = exportToSvg(drawitPath, ctx.vaultPath, opts.padding ?? 20);

  // 3. Convert to PNG (unless svgOnly)
  let pngPath: string | undefined;
  if (!opts.svgOnly) {
    const svgContent = fs.readFileSync(svgPath, "utf-8");
    const pngBytes = await svgToPng(svgContent);
    pngPath = outputPath(ctx.vaultPath, "png");
    fs.writeFileSync(pngPath, pngBytes);
  }

  const displayName = `${safeName}.png`;
  return { drawitPath, svgPath, pngPath, displayName };
}

// ---------------------------------------------------------------------------
// Tool 1: drawit_render
// ---------------------------------------------------------------------------

interface RenderInput {
  name: string;
  content: string;
  folder?: string;
  svgOnly?: boolean;
}

export const DrawItRenderTool: HQTool<RenderInput, string> = {
  name: "drawit_render",
  description:
    "All-in-one diagram pipeline: save NDJSON content as a .drawit file, export to SVG, convert to PNG, and return a shareable file marker. Use load_skill('drawit') first to learn the NDJSON format.",
  tags: [
    "diagram",
    "drawit",
    "render",
    "flowchart",
    "architecture",
    "image",
    "svg",
    "png",
    "chart",
    "visual",
  ],
  schema: Type.Object({
    name: Type.String({
      description: "Diagram name (becomes filename, e.g., 'login-flow')",
    }),
    content: Type.String({
      description:
        "Full NDJSON content: metadata line + element lines (one JSON object per line)",
    }),
    folder: Type.Optional(
      Type.String({
        description:
          "Subfolder under Notebooks/Diagrams/ (optional, e.g., 'architecture')",
      })
    ),
    svgOnly: Type.Optional(
      Type.Boolean({
        description: "Skip PNG conversion and return SVG only (default: false)",
      })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: RenderInput, ctx: HQContext): Promise<string> {
    const result = await renderPipeline(input.name, input.content, ctx, {
      folder: input.folder,
      svgOnly: input.svgOnly,
    });

    const filePath = result.pngPath ?? result.svgPath;
    const ext = result.pngPath ? "png" : "svg";
    const displayName = `${sanitizeName(input.name)}.${ext}`;

    return [
      `Diagram saved: ${result.drawitPath}`,
      `SVG exported: ${result.svgPath}`,
      result.pngPath ? `PNG converted: ${result.pngPath}` : null,
      `[FILE: ${filePath} | ${displayName}]`,
    ]
      .filter(Boolean)
      .join("\n");
  },
};

// ---------------------------------------------------------------------------
// Tool 2: drawit_export
// ---------------------------------------------------------------------------

interface ExportInput {
  file: string;
  format: "svg" | "png";
  padding?: number;
}

export const DrawItExportTool: HQTool<ExportInput, string> = {
  name: "drawit_export",
  description:
    "Export an existing .drawit file to SVG or PNG format. For SVG, uses the DrawIt CLI renderer. For PNG, exports to SVG first then converts via resvg.",
  tags: ["diagram", "drawit", "export", "svg", "png", "convert"],
  schema: Type.Object({
    file: Type.String({
      description: "Absolute path to the .drawit file to export",
    }),
    format: Type.Union([Type.Literal("svg"), Type.Literal("png")], {
      description: "Output format: svg or png",
    }),
    padding: Type.Optional(
      Type.Number({ description: "Padding in pixels around the diagram (default: 20)" })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: ExportInput, ctx: HQContext): Promise<string> {
    if (!fs.existsSync(input.file)) {
      throw new Error(`File not found: ${input.file}`);
    }

    // Always export to SVG first
    const svgPath = exportToSvg(input.file, ctx.vaultPath, input.padding ?? 20);

    if (input.format === "svg") {
      const displayName = path.basename(input.file, ".drawit") + ".svg";
      return `Exported SVG: ${svgPath}\n[FILE: ${svgPath} | ${displayName}]`;
    }

    // Convert SVG → PNG
    const svgContent = fs.readFileSync(svgPath, "utf-8");
    const pngBytes = await svgToPng(svgContent);
    const pngPath = outputPath(ctx.vaultPath, "png");
    fs.writeFileSync(pngPath, pngBytes);
    const displayName = path.basename(input.file, ".drawit") + ".png";
    return `Exported PNG: ${pngPath}\n[FILE: ${pngPath} | ${displayName}]`;
  },
};

// ---------------------------------------------------------------------------
// Tool 3: drawit_map
// ---------------------------------------------------------------------------

interface MapInput {
  path?: string;
  depth?: number;
  mode?: "auto" | "files" | "dirs";
  include?: string;
  split?: boolean;
}

export const DrawItMapTool: HQTool<MapInput, string> = {
  name: "drawit_map",
  description:
    "Analyze a codebase and generate a .drawit architecture map. Auto-scales between file-level import graphs and directory-level overviews. Wraps `drawit map`.",
  tags: [
    "diagram",
    "drawit",
    "codebase",
    "map",
    "architecture",
    "code",
    "imports",
    "dependencies",
  ],
  schema: Type.Object({
    path: Type.Optional(
      Type.String({
        description: "Codebase path to analyze (default: current working directory)",
      })
    ),
    depth: Type.Optional(
      Type.Number({ description: "Max directory depth to scan (default: 4)" })
    ),
    mode: Type.Optional(
      Type.Union(
        [Type.Literal("auto"), Type.Literal("files"), Type.Literal("dirs")],
        {
          description:
            "Map mode: auto detects by file count, files=import graph, dirs=directory tree (default: auto)",
        }
      )
    ),
    include: Type.Optional(
      Type.String({
        description:
          'File extensions glob (default: "**/*.{ts,tsx,js,jsx}")',
      })
    ),
    split: Type.Optional(
      Type.Boolean({
        description: "Generate one diagram per top-level subdirectory",
      })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: MapInput, ctx: HQContext): Promise<string> {
    const dir = ensureDiagramsDir(ctx.vaultPath, "codebases");
    const targetPath = input.path ?? process.cwd();
    const dirName = path.basename(path.resolve(targetPath));
    const outputFile = path.join(dir, `${sanitizeName(dirName)}-map.drawit`);

    const args = ["map", targetPath, "--output", outputFile];
    if (input.depth) args.push("--depth", String(input.depth));
    if (input.mode) args.push("--mode", input.mode);
    if (input.include) args.push("--include", input.include);
    if (input.split) args.push("--split");

    runDrawIt(args, 60_000);

    // Export to PNG for sharing
    try {
      const svgPath = exportToSvg(outputFile, ctx.vaultPath);
      const svgContent = fs.readFileSync(svgPath, "utf-8");
      const pngBytes = await svgToPng(svgContent);
      const pngPath = outputPath(ctx.vaultPath, "png");
      fs.writeFileSync(pngPath, pngBytes);
      const displayName = `${sanitizeName(dirName)}-map.png`;
      return [
        `Codebase map generated: ${outputFile}`,
        `PNG: ${pngPath}`,
        `[FILE: ${pngPath} | ${displayName}]`,
      ].join("\n");
    } catch {
      // If PNG conversion fails, return the .drawit path
      return `Codebase map generated: ${outputFile}`;
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 4: drawit_flow
// ---------------------------------------------------------------------------

interface FlowInput {
  steps: string[];
  name?: string;
  renderPng?: boolean;
}

export const DrawItFlowTool: HQTool<FlowInput, string> = {
  name: "drawit_flow",
  description:
    "Generate a flowchart diagram from a list of steps. Steps ending with '?' become decision diamonds. First step becomes start, last becomes end. Wraps `drawit flow`.",
  tags: ["diagram", "drawit", "flowchart", "flow", "steps", "process"],
  schema: Type.Object({
    steps: Type.Array(Type.String(), {
      description:
        "Ordered list of step labels. Questions ending in '?' become diamonds.",
    }),
    name: Type.Optional(
      Type.String({ description: "Diagram name (default: 'flow')" })
    ),
    renderPng: Type.Optional(
      Type.Boolean({
        description: "Also export to PNG for sharing (default: true)",
      })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: FlowInput, ctx: HQContext): Promise<string> {
    if (!input.steps.length) {
      throw new Error("At least one step is required");
    }

    const dir = ensureDiagramsDir(ctx.vaultPath);
    const safeName = sanitizeName(input.name ?? "flow");
    const outputFile = path.join(dir, `${safeName}.drawit`);

    const args = ["flow", ...input.steps, "--output", outputFile];
    runDrawIt(args);

    const shouldRenderPng = input.renderPng !== false;
    if (shouldRenderPng) {
      try {
        const svgPath = exportToSvg(outputFile, ctx.vaultPath);
        const svgContent = fs.readFileSync(svgPath, "utf-8");
        const pngBytes = await svgToPng(svgContent);
        const pngPath = outputPath(ctx.vaultPath, "png");
        fs.writeFileSync(pngPath, pngBytes);
        const displayName = `${safeName}.png`;
        return [
          `Flowchart generated: ${outputFile}`,
          `PNG: ${pngPath}`,
          `[FILE: ${pngPath} | ${displayName}]`,
        ].join("\n");
      } catch {
        return `Flowchart generated: ${outputFile} (PNG conversion failed)`;
      }
    }

    return `Flowchart generated: ${outputFile}`;
  },
};

// ---------------------------------------------------------------------------
// Tool 5: drawit_analyze
// ---------------------------------------------------------------------------

interface AnalyzeInput {
  action: "validate" | "inspect" | "deps" | "routes" | "schema";
  path: string;
  strict?: boolean;
  renderPng?: boolean;
}

export const DrawItAnalyzeTool: HQTool<AnalyzeInput, string> = {
  name: "drawit_analyze",
  description:
    "Analyze diagrams or generate them from project artifacts. Actions: validate (check .drawit file), inspect (show summary), deps (package dependency graph), routes (Next.js route tree), schema (Prisma ER diagram).",
  tags: [
    "diagram",
    "drawit",
    "validate",
    "inspect",
    "deps",
    "routes",
    "schema",
    "prisma",
    "nextjs",
    "analyze",
  ],
  schema: Type.Object({
    action: Type.Union(
      [
        Type.Literal("validate"),
        Type.Literal("inspect"),
        Type.Literal("deps"),
        Type.Literal("routes"),
        Type.Literal("schema"),
      ],
      {
        description:
          "Analysis action: validate/inspect for .drawit files, deps/routes/schema to generate diagrams from project artifacts",
      }
    ),
    path: Type.String({
      description:
        "Path to the .drawit file (validate/inspect) or project directory/schema file (deps/routes/schema)",
    }),
    strict: Type.Optional(
      Type.Boolean({
        description: "Enable strict Zod validation (validate action only)",
      })
    ),
    renderPng: Type.Optional(
      Type.Boolean({
        description:
          "Export generated diagram to PNG (deps/routes/schema only, default: true)",
      })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: AnalyzeInput, ctx: HQContext): Promise<string> {
    if (!fs.existsSync(input.path)) {
      throw new Error(`Path not found: ${input.path}`);
    }

    switch (input.action) {
      case "validate": {
        const args = ["validate", input.path];
        if (input.strict) args.push("--strict");
        const result = runDrawIt(args);
        return result || "Diagram is valid.";
      }

      case "inspect": {
        const result = runDrawIt(["inspect", input.path, "--elements"]);
        return result;
      }

      case "deps":
      case "routes":
      case "schema": {
        const dir = ensureDiagramsDir(ctx.vaultPath);
        const dirName = path.basename(path.resolve(input.path));
        const safeName = sanitizeName(`${dirName}-${input.action}`);
        const outputFile = path.join(dir, `${safeName}.drawit`);

        runDrawIt([input.action, input.path, "--output", outputFile], 60_000);

        const shouldRenderPng = input.renderPng !== false;
        if (shouldRenderPng) {
          try {
            const svgPath = exportToSvg(outputFile, ctx.vaultPath);
            const svgContent = fs.readFileSync(svgPath, "utf-8");
            const pngBytes = await svgToPng(svgContent);
            const pngPath = outputPath(ctx.vaultPath, "png");
            fs.writeFileSync(pngPath, pngBytes);
            const displayName = `${safeName}.png`;
            return [
              `${input.action} diagram generated: ${outputFile}`,
              `PNG: ${pngPath}`,
              `[FILE: ${pngPath} | ${displayName}]`,
            ].join("\n");
          } catch {
            return `${input.action} diagram generated: ${outputFile} (PNG conversion failed)`;
          }
        }

        return `${input.action} diagram generated: ${outputFile}`;
      }

      default:
        throw new Error(`Unknown action: ${input.action}`);
    }
  },
};

// ---------------------------------------------------------------------------
// Tool 6: create_diagram (high-level, no NDJSON knowledge needed)
// ---------------------------------------------------------------------------

interface CreateDiagramInput {
  title: string;
  nodes: string[];
  edges?: string[];
  theme?: "dark" | "light";
}

/**
 * Generate NDJSON internally from structured input — the LLM never touches
 * raw NDJSON. Automatic grid layout, color palette, and canvas sizing.
 */
function buildStructuredDiagram(input: CreateDiagramInput): string {
  const isDark = (input.theme ?? "dark") === "dark";
  const bg = isDark ? "#0a0f1e" : "#ffffff";
  const textColor = isDark ? "#e2e8f0" : "#333333";
  const palette = isDark
    ? ["#1e3a5f", "#2d4a3f", "#4a2d5f", "#5f3a1e", "#1e5f5a", "#5f1e3a"]
    : ["#e3f2fd", "#e8f5e9", "#f3e5f5", "#fff3e0", "#e0f7fa", "#fce4ec"];
  const strokes = isDark
    ? ["#3b82f6", "#34d399", "#a78bfa", "#f59e0b", "#22d3ee", "#f87171"]
    : ["#1976d2", "#4caf50", "#7b1fa2", "#ff9800", "#00bcd4", "#f44336"];

  const cols = Math.ceil(Math.sqrt(input.nodes.length));
  const nodeW = 180, nodeH = 60, gapX = 80, gapY = 80, pad = 80;
  const rows = Math.ceil(input.nodes.length / cols);
  const canvasW = pad * 2 + cols * nodeW + (cols - 1) * gapX;
  const canvasH = pad * 2 + rows * nodeH + (rows - 1) * gapY;

  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      width: canvasW,
      height: canvasH,
      background: bg,
      metadata: { name: input.title, diagramType: "architecture" },
    })
  );

  const nodeIds: Record<string, string> = {};
  input.nodes.forEach((label, i) => {
    const id = `n${i}`;
    nodeIds[label] = id;
    const col = i % cols, row = Math.floor(i / cols);
    const x = pad + col * (nodeW + gapX), y = pad + row * (nodeH + gapY);
    const ci = i % palette.length;
    lines.push(
      JSON.stringify({
        id,
        type: "node",
        position: { x, y },
        size: { width: nodeW, height: nodeH },
        shape: "rectangle",
        zIndex: 2,
        style: {
          fillStyle: palette[ci],
          strokeStyle: strokes[ci],
          lineWidth: 2,
          fillOpacity: 1,
          strokeOpacity: 1,
          cornerRadii: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
        },
        text: {
          content: label,
          fontSize: 14,
          fontFamily: "sans-serif",
          color: textColor,
          textAlign: "center",
          verticalAlign: "middle",
        },
      })
    );
  });

  (input.edges ?? []).forEach((pair, i) => {
    const [from, to] = pair.split(">").map((s) => s.trim());
    const sourceId = nodeIds[from], targetId = nodeIds[to];
    if (!sourceId || !targetId) return;
    lines.push(
      JSON.stringify({
        id: `e${i}`,
        type: "edge",
        source: sourceId,
        target: targetId,
        zIndex: 1,
        style: {
          strokeStyle: isDark ? "#94a3b8" : "#64748B",
          lineWidth: 2,
          arrowheadEnd: true,
          strokeOpacity: 0.8,
          routing: "orthogonal",
        },
      })
    );
  });

  return lines.join("\n") + "\n";
}

export const CreateDiagramTool: HQTool<CreateDiagramInput, string> = {
  name: "create_diagram",
  description:
    "Create a diagram from simple structured input — NO NDJSON knowledge needed. " +
    "Provide a title, node labels, and edges (as 'NodeA>NodeB'). " +
    "Handles layout, styling, SVG export, and PNG conversion automatically. " +
    "Returns a shareable image. For flowcharts, prefer drawit_flow instead.",
  tags: [
    "diagram",
    "create",
    "architecture",
    "chart",
    "visual",
    "image",
    "nodes",
    "edges",
    "graph",
  ],
  schema: Type.Object({
    title: Type.String({ description: "Diagram title (becomes filename)" }),
    nodes: Type.Array(Type.String(), {
      description:
        'Node labels, e.g. ["Frontend", "Backend", "Database", "Cache"]',
    }),
    edges: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Connections as "Source>Target", e.g. ["Frontend>Backend", "Backend>Database"]',
      })
    ),
    theme: Type.Optional(
      Type.Union([Type.Literal("dark"), Type.Literal("light")], {
        description: "Color theme (default: dark)",
      })
    ),
  }),
  requiresWriteAccess: true,

  async execute(input: CreateDiagramInput, ctx: HQContext): Promise<string> {
    if (!input.nodes.length) {
      throw new Error("At least one node is required");
    }

    const content = buildStructuredDiagram(input);
    const dir = ensureDiagramsDir(ctx.vaultPath);
    const safeName = sanitizeName(input.title);
    const drawitPath = path.join(dir, `${safeName}.drawit`);
    fs.writeFileSync(drawitPath, content, "utf-8");

    // Export SVG → PNG
    const svgPath = exportToSvg(drawitPath, ctx.vaultPath);
    const svgContent = fs.readFileSync(svgPath, "utf-8");
    const pngBytes = await svgToPng(svgContent);
    const pngPath = outputPath(ctx.vaultPath, "png");
    fs.writeFileSync(pngPath, pngBytes);

    const displayName = `${safeName}.png`;
    return [
      `Diagram created: ${drawitPath}`,
      `[FILE: ${pngPath} | ${displayName}]`,
    ].join("\n");
  },
};
