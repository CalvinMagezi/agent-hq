export type PlanningMode = "act" | "sketch" | "blueprint";

export interface ModeConfig {
  mode: PlanningMode;
  maxQuestions: number;
  diagrams: boolean;
  screenshots: boolean;
  BDD: boolean;
  priority: number;
}

export const MODE_CONFIGS: Record<PlanningMode, ModeConfig> = {
  act: {
    mode: "act",
    maxQuestions: 1,
    diagrams: false,
    screenshots: false,
    BDD: false,
    priority: 90,
  },
  sketch: {
    mode: "sketch",
    maxQuestions: 3,
    diagrams: true,
    screenshots: false,
    BDD: true,
    priority: 80,
  },
  blueprint: {
    mode: "blueprint",
    maxQuestions: 100, // unlimited
    diagrams: true,
    screenshots: true,
    BDD: true,
    priority: 70,
  },
};

export function getPlanningMode(score: number): PlanningMode {
  if (score < 0.2) return "act";
  if (score <= 0.5) return "sketch";
  return "blueprint";
}
