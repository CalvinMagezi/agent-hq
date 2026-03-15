import type { AmbiguitySignal } from "./planDB.js";

export interface AmbiguityReport {
  signals: AmbiguitySignal[];
  score: number;
}

export function detectAmbiguity(
  instruction: string,
  codemapSummary: string,
  project: string
): AmbiguityReport {
  const signals: AmbiguitySignal[] = [];
  let score = 0;

  // 1. missing_actor: Passive voice without subject
  const missingActorRegex = /\b(make|should|needs? to|must)\b.*\b(it|this|that)\b/i;
  const missingActorMatch = instruction.match(missingActorRegex);
  if (missingActorMatch) {
    signals.push({
      type: "missing_actor",
      description: "Passive instruction missing clear subject (who performs the action?)",
      excerpt: missingActorMatch[0],
      severity: "medium"
    });
    score += 0.25;
  }

  // 2. undefined_scope: Bare verb + single noun
  const undefinedScopeRegex = /\b(add|improve|implement|build|create|fix)\s+(\w+)\s*$/i;
  const undefinedScopeMatch = instruction.match(undefinedScopeRegex);
  if (undefinedScopeMatch) {
    signals.push({
      type: "undefined_scope",
      description: `Vague scope: '${undefinedScopeMatch[1]}' without specific details`,
      excerpt: undefinedScopeMatch[0],
      severity: "high"
    });
    score += 0.4;
  }

  // 3. conflicting_requirements: Contradiction pairs
  const conflicts = [
    ["simple", "microservices"],
    ["fast", "comprehensive"],
    ["lightweight", "full-featured"],
    ["single-page", "multi-service"],
    ["quick", "thorough"],
  ];
  for (const [a, b] of conflicts) {
    if (instruction.toLowerCase().includes(a) && instruction.toLowerCase().includes(b)) {
      signals.push({
        type: "conflicting_requirements",
        description: `Potential conflict between '${a}' and '${b}' requirements`,
        excerpt: `${a}...${b}`,
        severity: "medium"
      });
      score += 0.3;
    }
  }

  // 4. unreferenced_entity: Capitalized compound nouns not in codemap
  // Simple heuristic: CamelCase or kebab-case words that look like technical entities
  const entityRegex = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+|[a-z]+(?:-[a-z]+)+)\b/g;
  let match;
  const entities = new Set<string>();
  while ((match = entityRegex.exec(instruction)) !== null) {
    entities.add(match[0]);
  }

  for (const entity of entities) {
    if (!codemapSummary.toLowerCase().includes(entity.toLowerCase())) {
      signals.push({
        type: "unreferenced_entity",
        description: `Entity '${entity}' not found in codebase codemap`,
        excerpt: entity,
        severity: "low"
      });
      score += 0.15;
    }
  }

  // 5. vague_quantifier
  const vagueRegex = /\b(some|various|multiple|several|etc\.?|and more|many)\b/i;
  const vagueMatch = instruction.match(vagueRegex);
  if (vagueMatch) {
    signals.push({
      type: "vague_quantifier",
      description: "Vague quantifier used (how many/which ones?)",
      excerpt: vagueMatch[0],
      severity: "low"
    });
    score += 0.1;
  }

  return { signals, score: Math.min(1.0, score) };
}
