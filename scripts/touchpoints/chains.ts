/**
 * Synaptic Chains — Declarative registry of touch point sequences.
 *
 * Chains describe how touch point outputs (emit entries) propagate to
 * downstream inputs. The engine uses this to resolve chain names to steps,
 * but chain propagation is actually driven by the emit[] field on
 * TouchPointResult, not by this registry directly.
 *
 * This file serves as:
 *   1. Documentation of the intended flow
 *   2. A reference for config file chain names
 *   3. A source of chain metadata the engine can log
 */

export interface SynapticChain {
  name: string;
  description: string;
  steps: string[];  // touch point names in order
}

export const SYNAPTIC_CHAINS: SynapticChain[] = [
  {
    name: "new-note-quality",
    description: "New note → fix frontmatter → suggest tags → ready for embedding",
    steps: ["frontmatter-fixer", "tag-suggester"],
  },
  {
    name: "conversation-harvest",
    description: "Thread goes stale → learn from conversation → create memories",
    steps: ["stale-thread-detector", "conversation-learner"],
  },
  {
    name: "growth-alert",
    description: "File grows large → alert user on active channel",
    steps: ["size-watchdog"],  // terminal — no further propagation
  },
  {
    name: "news-digest",
    description: "HEARTBEAT pulse → cluster into topic briefs → link to vault notes",
    steps: ["news-clusterer", "news-linker"],
  },
];

/** Convenience: get a chain by name */
export function getChain(name: string): SynapticChain | undefined {
  return SYNAPTIC_CHAINS.find(c => c.name === name);
}

/** Get all chain names for config file validation */
export function getChainNames(): string[] {
  return SYNAPTIC_CHAINS.map(c => c.name);
}
