import { describe, test, expect } from "bun:test";
import { detectAmbiguity } from "../ambiguityDetector.js";

describe("Ambiguity Detector", () => {
  test("detects missing actor", () => {
    const report = detectAmbiguity("make it work", "", "proj");
    const signal = report.signals.find(s => s.type === "missing_actor");
    expect(signal).toBeDefined();
    expect(report.score).toBeGreaterThan(0);
  });

  test("detects undefined scope", () => {
    const report = detectAmbiguity("implement security", "", "proj");
    const signal = report.signals.find(s => s.type === "undefined_scope");
    expect(signal).toBeDefined();
    expect(report.score).toBeGreaterThan(0.3);
  });

  test("detects conflicting requirements", () => {
    const report = detectAmbiguity("simple microservices architecture", "", "proj");
    const signal = report.signals.find(s => s.type === "conflicting_requirements");
    expect(signal).toBeDefined();
  });

  test("detects unreferenced entities", () => {
    const report = detectAmbiguity("Add AuthProvider", "empty codemap", "proj");
    const signal = report.signals.find(s => s.type === "unreferenced_entity");
    expect(signal).toBeDefined();
  });

  test("detects vague quantifiers", () => {
    const report = detectAmbiguity("fix multiple bugs", "", "proj");
    const signal = report.signals.find(s => s.type === "vague_quantifier");
    expect(signal).toBeDefined();
  });

  test("calculates reasonable score", () => {
    const lowReport = detectAmbiguity("fix bug", "bug", "proj");
    const highReport = detectAmbiguity("implement many things and make it work simple microservices", "", "proj");
    expect(highReport.score).toBeGreaterThan(lowReport.score);
  });
});
