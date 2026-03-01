/**
 * Orchestrator — intent classification for WhatsApp HQ routing.
 *
 * Classifies incoming messages as workspace, coding, or general so the
 * WhatsApp bot can delegate to the right Discord harness automatically.
 */

export type OrchestrationIntent = "workspace" | "coding" | "general";
export type TargetHarness = "gemini-cli" | "claude-code" | "any";

const WORKSPACE_PATTERNS = [
  /\bcalendar\b/i,
  /\bgmail\b/i,
  /\bemail\b/i,
  /\bmail\b/i,
  /\bdrive\b/i,
  /\bgoogle docs?\b/i,
  /\bgoogle sheets?\b/i,
  /\bspreadsheet\b/i,
  /\bgoogle meet\b/i,
  /\bmeeting\b.*\b(schedule|create|add|book)\b/i,
  /\b(schedule|book|create|add)\b.*\bmeeting\b/i,
  /\bevent\b.*\b(calendar|schedule|add|create)\b/i,
  /\b(calendar|schedule|add|create)\b.*\bevent\b/i,
  /\bworkspace\b/i,
  /\bgoogle\b.*\b(doc|sheet|slide|form|keep)\b/i,
  /\b(doc|sheet|slide|form|keep)\b.*\bgoogle\b/i,
  /\bmy (calendar|inbox|emails?|meetings?|events?)\b/i,
  /\b(fetch|get|check|show|read|list)\b.*\b(calendar|inbox|emails?|meetings?|events?)\b/i,
  /\b(send|compose|draft)\b.*\b(email|message|mail)\b/i,
  /\btomorrow\b.*\b(schedule|calendar|meetings?)\b/i,
  /\b(schedule|calendar|meetings?)\b.*\btomorrow\b/i,
];

const CODING_PATTERNS = [
  /\bgit\b/i,
  /\bcommit\b/i,
  /\bpush\b.*\b(code|branch|changes?)\b/i,
  /\bdeploy\b/i,
  /\bdebug\b/i,
  /\brefactor\b/i,
  /\bpull request\b/i,
  /\bcode review\b/i,
  /\btype ?script\b/i,
  /\b(fix|write|edit|update|create)\b.*\b(code|function|class|component|module|file|test)\b/i,
  /\b(code|function|class|component|module|file|test)\b.*\b(fix|write|edit|update|create)\b/i,
  /\bbug\b.*\b(fix|in)\b/i,
  /\b(build|compile|lint|test)\b.*\b(fail|error|pass)\b/i,
  /\bnpm\b|\bbun\b.*\b(install|run|build)\b/i,
  /\bpackage\.json\b/i,
  /\brepository\b|\brepo\b/i,
  /\bbranch\b.*\bgit\b|\bgit\b.*\bbranch\b/i,
];

/**
 * Classify a message to determine which harness should handle it.
 * Returns the intent type and the target harness.
 */
export function detectIntent(message: string): {
  intent: OrchestrationIntent;
  harness: TargetHarness;
} {
  const lower = message.toLowerCase();

  // Check workspace patterns first (more specific)
  for (const pattern of WORKSPACE_PATTERNS) {
    if (pattern.test(lower)) {
      return { intent: "workspace", harness: "gemini-cli" };
    }
  }

  // Check coding patterns
  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(lower)) {
      return { intent: "coding", harness: "claude-code" };
    }
  }

  return { intent: "general", harness: "any" };
}
