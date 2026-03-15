/**
 * Integration test: Multi-Modal Planning System
 *
 * Exercises the full flow: plan_create (folder) → plan_attach → plan_visualize → plan_gallery → plan_status
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { Database } from "bun:sqlite";
import { openPlanDB, getPlan, getPlanAssets } from "../planDB.js";
import type { HQContext } from "../registry.js";

// Import tools directly
import {
  PlanCreateTool,
  PlanStatusTool,
  PlanAttachTool,
  PlanGalleryTool,
} from "../tools/planning.js";

let db: Database;
let tmpDir: string;
let ctx: HQContext;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multimodal-plan-test-"));

  // Create vault structure
  fs.mkdirSync(path.join(tmpDir, "_plans", "active"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "_jobs", "pending"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "_embeddings"), { recursive: true });

  db = openPlanDB(tmpDir);

  ctx = {
    vaultPath: tmpDir,
    planDB: db,
    securityProfile: "ADMIN",
  } as HQContext;
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("Multi-Modal Plan E2E", () => {
  test("plan_create creates folder with plan.md + manifest.json + asset subdirs", async () => {
    const result = await PlanCreateTool.execute(
      { instruction: "Build a notification system with WebSocket support" },
      ctx
    );

    expect(result.planId).toMatch(/^plan-/);
    expect(result.status).toBe("delegated");
    expect(result.planningMode).toBeDefined();
    expect(result.ambiguitySignals).toBeInstanceOf(Array);

    // Verify folder structure
    const planDir = path.join(tmpDir, "_plans", "active", result.planId);
    expect(fs.existsSync(planDir)).toBe(true);
    expect(fs.statSync(planDir).isDirectory()).toBe(true);

    // plan.md exists with frontmatter
    const planMd = path.join(planDir, "plan.md");
    expect(fs.existsSync(planMd)).toBe(true);
    const planContent = fs.readFileSync(planMd, "utf-8");
    expect(planContent).toContain("planId:");
    expect(planContent).toContain("planningMode:");
    expect(planContent).toContain("Build a notification system");

    // manifest.json exists
    const manifestFile = path.join(planDir, "manifest.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
    expect(manifest.planId).toBe(result.planId);
    expect(manifest.version).toBe(1);
    expect(manifest.assets).toEqual([]);

    // Asset subdirectories exist
    expect(fs.existsSync(path.join(planDir, "assets", "screenshots"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "assets", "diagrams"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "assets", "scenarios"))).toBe(true);

    // Delegation job created
    const jobFile = path.join(tmpDir, "_jobs", "pending", `${result.planId}-delegation.md`);
    expect(fs.existsSync(jobFile)).toBe(true);
    const jobContent = fs.readFileSync(jobFile, "utf-8");
    expect(jobContent).toContain("**Mode**:");
  });

  test("ambiguity detection selects correct planning mode", async () => {
    // Simple, clear instruction → act mode
    const clearResult = await PlanCreateTool.execute(
      { instruction: "Fix the typo in README.md line 42" },
      ctx
    );
    // Very specific instruction should get "act" or "sketch" at most
    expect(["act", "sketch"]).toContain(clearResult.planningMode);

    // Vague, ambiguous instruction → sketch or blueprint
    const vagueResult = await PlanCreateTool.execute(
      { instruction: "Make it work better with various improvements and some new features" },
      ctx
    );
    expect(vagueResult.ambiguitySignals.length).toBeGreaterThan(0);
    expect(["sketch", "blueprint"]).toContain(vagueResult.planningMode);

    // Conflicting instruction → higher mode
    const conflictResult = await PlanCreateTool.execute(
      { instruction: "Build a simple microservices architecture that is lightweight but full-featured" },
      ctx
    );
    expect(conflictResult.ambiguitySignals.some((s: any) => s.type === "conflicting_requirements")).toBe(true);
  });

  test("plan_attach copies file into plan folder and updates manifest", async () => {
    // Create a plan first
    const plan = await PlanCreateTool.execute(
      { instruction: "Add dark mode to the dashboard" },
      ctx
    );

    // Create a fake screenshot file
    const fakeScreenshot = path.join(tmpDir, "test-screenshot.png");
    fs.writeFileSync(fakeScreenshot, "fake-png-data");

    // Attach it
    const attachResult = await PlanAttachTool.execute(
      {
        planId: plan.planId,
        type: "screenshot",
        sourcePath: fakeScreenshot,
        label: "Current dashboard state",
      },
      ctx
    );

    expect(attachResult.assetId).toMatch(/^asset-/);
    expect(attachResult.relativePath).toContain("screenshots");
    expect(attachResult.manifestVersion).toBe(2); // bumped from 1

    // Verify file was copied
    const planDir = path.join(tmpDir, "_plans", "active", plan.planId);
    const copiedFile = path.join(planDir, attachResult.relativePath);
    expect(fs.existsSync(copiedFile)).toBe(true);
    expect(fs.readFileSync(copiedFile, "utf-8")).toBe("fake-png-data");

    // Verify manifest updated
    const manifest = JSON.parse(fs.readFileSync(path.join(planDir, "manifest.json"), "utf-8"));
    expect(manifest.version).toBe(2);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0].label).toBe("Current dashboard state");

    // Verify DB
    const dbAssets = getPlanAssets(db, plan.planId);
    expect(dbAssets).toHaveLength(1);
    expect(dbAssets[0].asset_type).toBe("screenshot");
  });

  test("plan_gallery returns assets with type breakdown", async () => {
    const plan = await PlanCreateTool.execute(
      { instruction: "Refactor auth module" },
      ctx
    );

    // Attach 2 screenshots and 1 diagram
    for (const [name, type] of [["s1.png", "screenshot"], ["s2.png", "screenshot"], ["d1.svg", "diagram"]] as const) {
      const tmpFile = path.join(tmpDir, name);
      fs.writeFileSync(tmpFile, `data-${name}`);
      await PlanAttachTool.execute(
        { planId: plan.planId, type, sourcePath: tmpFile, label: `Test ${name}` },
        ctx
      );
    }

    // Gallery
    const gallery = await PlanGalleryTool.execute({ planId: plan.planId }, ctx);
    expect(gallery.totalCount).toBe(3);
    expect(gallery.byType.screenshots).toBe(2);
    expect(gallery.byType.diagrams).toBe(1);
    expect(gallery.byType.scenarios).toBe(0);

    // Filtered gallery
    const screenshotsOnly = await PlanGalleryTool.execute(
      { planId: plan.planId, type: "screenshot" },
      ctx
    );
    expect(screenshotsOnly.totalCount).toBe(2);
  });

  test("plan_status includes asset summary", async () => {
    const plan = await PlanCreateTool.execute(
      { instruction: "Add user profiles page" },
      ctx
    );

    // Attach a file
    const tmpFile = path.join(tmpDir, "arch.png");
    fs.writeFileSync(tmpFile, "diagram-data");
    await PlanAttachTool.execute(
      { planId: plan.planId, type: "diagram", sourcePath: tmpFile, label: "Architecture" },
      ctx
    );

    const status = await PlanStatusTool.execute({ planId: plan.planId }, ctx);
    expect(status.planningMode).toBeDefined();
    expect(status.assetCount).toBe(1);
    expect(status.assetSummary).toEqual({
      screenshots: 0,
      diagrams: 1,
      scenarios: 0,
    });
    expect(status.ambiguitySignals).toBeInstanceOf(Array);
  });

  test("plan_attach migrates flat file to folder", async () => {
    // Simulate a legacy flat-file plan
    const legacyPlanId = "plan-legacy-001";
    const legacyFile = path.join(tmpDir, "_plans", "active", `${legacyPlanId}.md`);
    fs.writeFileSync(legacyFile, "---\nplanId: plan-legacy-001\nstatus: delegated\n---\n# Legacy Plan\n");

    // Also insert into DB
    const { upsertPlan } = await import("../planDB.js");
    upsertPlan(db, { id: legacyPlanId, project: "test", title: "Legacy", instruction: "Old plan" });

    // Attach a file — should trigger migration
    const tmpFile = path.join(tmpDir, "shot.png");
    fs.writeFileSync(tmpFile, "screenshot-bytes");

    const result = await PlanAttachTool.execute(
      { planId: legacyPlanId, type: "screenshot", sourcePath: tmpFile, label: "Migrated" },
      ctx
    );

    // The flat file should now be gone, replaced by a folder
    expect(fs.existsSync(legacyFile)).toBe(false);
    const planDir = path.join(tmpDir, "_plans", "active", legacyPlanId);
    expect(fs.statSync(planDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(planDir, "plan.md"))).toBe(true);
    expect(fs.existsSync(path.join(planDir, "manifest.json"))).toBe(true);

    // Original content preserved
    const migratedContent = fs.readFileSync(path.join(planDir, "plan.md"), "utf-8");
    expect(migratedContent).toContain("Legacy Plan");
  });
});
