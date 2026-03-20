/**
 * Orchestrator — intent classification for relay adapter routing.
 *
 * Classifies incoming messages as workspace, coding, or general so the
 * relay bot can delegate to the right harness automatically.
 */

export type OrchestrationIntent = "workspace" | "coding" | "orchestration" | "general";
export type TargetHarness = "gemini-cli" | "claude-code" | "opencode" | "qwen-code" | "mistral-vibe" | "hq" | "any";
export type DetectedRole = "workspace" | "coder" | "researcher" | "reviewer" | "planner" | "devops";

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

// HQ-specific patterns — vault context, task management, orchestration
const HQ_PATTERNS = [
  /\b(vault|memory|context|brief|inbox|status|project)\b.*\b(search|find|check|show|list|read|scan)\b/i,
  /\b(search|find|check|show|list|read|scan)\b.*\b(vault|memory|context|brief|inbox|project)\b/i,
  /\bwhat should (i|we) work on\b/i,
  /\bmorning brief\b/i,
  /\b(summarize|recap|review)\b.*\b(today|yesterday|week|progress)\b/i,
  /\btask\b.*\b(status|list|pending|create)\b/i,
  /\b(pinned|recent)\b.*\b(notes?|context)\b/i,
];

export function detectIntent(message: string): {
  intent: OrchestrationIntent;
  harness: TargetHarness;
  role: DetectedRole;
} {
  const lower = message.toLowerCase();

  // HQ orchestration tasks get routed to HQ agent
  for (const pattern of HQ_PATTERNS) {
    if (pattern.test(lower)) {
      return { intent: "orchestration", harness: "hq", role: "planner" };
    }
  }

  for (const pattern of WORKSPACE_PATTERNS) {
    if (pattern.test(lower)) {
      return { intent: "workspace", harness: "gemini-cli", role: "workspace" };
    }
  }

  for (const pattern of CODING_PATTERNS) {
    if (pattern.test(lower)) {
      let role: DetectedRole = "coder";
      if (/\b(review|audit|validate|security)\b/i.test(lower)) role = "reviewer";
      else if (/\b(plan|design|architect|spec)\b/i.test(lower)) role = "planner";
      else if (/\b(deploy|ci|cd|docker|infra|server)\b/i.test(lower)) role = "devops";
      else if (/\b(research|investigate|explain|compare)\b/i.test(lower)) role = "researcher";
      return { intent: "coding", harness: "hq", role };
    }
  }

  return { intent: "general", harness: "any", role: "coder" };
}
