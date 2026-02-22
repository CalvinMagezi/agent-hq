import type { ConvexAPI } from "./vaultApi.js";

/**
 * Parse Claude's response for memory intent tags.
 * Saves facts/goals to Convex and returns the cleaned response.
 *
 * Supported tags (hidden from user, processed automatically):
 *   [REMEMBER: fact to store]
 *   [GOAL: goal text]
 *   [GOAL: goal text | DEADLINE: date]
 *   [DONE: search text for completed goal]
 *
 * Tags must contain at least 5 chars of actual content to avoid
 * storing parsing artifacts like "] and [GOAL:" etc.
 */
export async function processMemoryIntents(
  convex: ConvexAPI,
  response: string,
): Promise<string> {
  let clean = response;

  // [REMEMBER: fact to store] — require 5+ meaningful chars
  const rememberMatches = [
    ...response.matchAll(/\[REMEMBER:\s*([^\]]{5,}?)\]/gi),
  ];
  for (const match of rememberMatches) {
    const fact = match[1].trim();
    if (fact && !looksLikeArtifact(fact)) {
      await convex.storeMemory("fact", fact);
    }
    clean = clean.replace(match[0], "");
  }

  // [GOAL: text] or [GOAL: text | DEADLINE: date] — require 5+ meaningful chars
  const goalMatches = [
    ...response.matchAll(
      /\[GOAL:\s*([^\]|]{5,}?)(?:\s*\|\s*DEADLINE:\s*([^\]]+?))?\]/gi,
    ),
  ];
  for (const match of goalMatches) {
    const goal = match[1].trim();
    if (goal && !looksLikeArtifact(goal)) {
      await convex.storeMemory("goal", goal, match[2]?.trim() || undefined);
    }
    clean = clean.replace(match[0], "");
  }

  // [DONE: search text for completed goal]
  const doneMatches = [...response.matchAll(/\[DONE:\s*([^\]]{3,}?)\]/gi)];
  for (const match of doneMatches) {
    const text = match[1].trim();
    if (text && !looksLikeArtifact(text)) {
      await convex.completeGoal(text);
    }
    clean = clean.replace(match[0], "");
  }

  return clean.trim();
}

/** Detect common parsing artifacts that shouldn't be stored as memories */
function looksLikeArtifact(text: string): boolean {
  const trimmed = text.trim();
  // Starts/ends with brackets, pipes, colons — leftover tag syntax
  if (/^[\]\[|:}\{]/.test(trimmed) || /[\]\[|:}\{]$/.test(trimmed)) return true;
  // Contains other tag markers — partial parse
  if (/\[(REMEMBER|GOAL|DONE):/i.test(trimmed)) return true;
  // Mostly punctuation / no alphabetic content
  if (!/[a-zA-Z]{3,}/.test(trimmed)) return true;
  return false;
}
