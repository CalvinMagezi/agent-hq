// EventBus — Typed publish/subscribe system for vault changes.
//
// Classifies raw FileChange events into semantic domain events based on
// the vault directory structure (jobs, delegation, system, notebooks).
//
// Supports type-specific subscriptions, wildcard subscriptions,
// filter-based subscriptions, error isolation, and async handlers.

import type {
  FileChange,
  VaultEvent,
  VaultEventType,
  VaultEventHandler,
  WatchFilter,
} from "./types";

interface FilteredSubscription {
  filter: WatchFilter;
  handler: VaultEventHandler;
}

export class EventBus {
  private handlers: Map<VaultEventType, Set<VaultEventHandler>> = new Map();
  private wildcardHandlers: Set<VaultEventHandler> = new Set();
  private filteredSubscriptions: Set<FilteredSubscription> = new Set();
  private debug: boolean;

  constructor(debug = false) {
    this.debug = debug;
  }

  /** Subscribe to a specific event type or "*" for all. Returns unsubscribe function. */
  on(
    eventType: VaultEventType | "*",
    handler: VaultEventHandler,
  ): () => void {
    if (eventType === "*") {
      this.wildcardHandlers.add(handler);
      return () => {
        this.wildcardHandlers.delete(handler);
      };
    }

    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);

    return () => {
      this.handlers.get(eventType)?.delete(handler);
    };
  }

  /** Subscribe with a filter. Returns unsubscribe function. */
  subscribe(filter: WatchFilter, handler: VaultEventHandler): () => void {
    const sub: FilteredSubscription = { filter, handler };
    this.filteredSubscriptions.add(sub);
    return () => {
      this.filteredSubscriptions.delete(sub);
    };
  }

  /** Emit an event to all matching subscribers. */
  async emit(event: VaultEvent): Promise<void> {
    if (this.debug) {
      console.log(`[vault-sync:event] ${event.type} → ${event.path}`);
    }

    const promises: Promise<void>[] = [];

    // Wildcard handlers
    for (const handler of this.wildcardHandlers) {
      promises.push(this.safeCall(handler, event));
    }

    // Type-specific handlers
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        promises.push(this.safeCall(handler, event));
      }
    }

    // Filtered subscriptions
    for (const sub of this.filteredSubscriptions) {
      if (this.matchesFilter(event, sub.filter)) {
        promises.push(this.safeCall(sub.handler, event));
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * Classify a raw FileChange into a semantic VaultEvent.
   * Maps filesystem paths to domain events based on vault directory structure.
   */
  classifyChange(change: FileChange): VaultEvent {
    const { path, type } = change;
    const timestamp = Date.now();
    const base = { path, change, timestamp };

    // ─── Job queue events ──────────────────────────────────────
    if (path.startsWith("_jobs/pending/")) {
      if (type === "create") {
        return { ...base, type: "job:created" };
      }
      if (type === "modify") {
        // A modify on a pending job is not a new job — treat as status change
        // (avoids duplicate job:created from scanner "create" + watcher "modify")
        return { ...base, type: "job:status-changed" };
      }
      if (type === "delete") {
        // Delete from pending means it was claimed (renamed to running/)
        return { ...base, type: "job:claimed" };
      }
    }

    if (path.startsWith("_jobs/running/")) {
      if (type === "create") {
        return { ...base, type: "job:claimed" };
      }
      if (type === "modify") {
        return { ...base, type: "job:status-changed" };
      }
    }

    if (
      path.startsWith("_jobs/done/") ||
      path.startsWith("_jobs/failed/")
    ) {
      return { ...base, type: "job:status-changed" };
    }

    // ─── Delegation events ─────────────────────────────────────
    if (path.startsWith("_delegation/pending/")) {
      if (type === "create") {
        return { ...base, type: "task:created" };
      }
      if (type === "modify") {
        // Same as job:created — avoid double event from scanner+watcher
        return { ...base, type: "task:status-changed" };
      }
      if (type === "delete") {
        return { ...base, type: "task:claimed" };
      }
    }

    if (path.startsWith("_delegation/claimed/")) {
      if (type === "create") {
        return { ...base, type: "task:claimed" };
      }
    }

    if (path.startsWith("_delegation/completed/")) {
      return { ...base, type: "task:completed" };
    }

    // ─── Approval events ──────────────────────────────────────
    if (path.startsWith("_approvals/pending/")) {
      if (type === "create") {
        return { ...base, type: "approval:created" };
      }
    }

    if (path.startsWith("_approvals/resolved/")) {
      if (type === "create") {
        return { ...base, type: "approval:resolved" };
      }
    }

    // ─── System files ─────────────────────────────────────────
    if (path.startsWith("_system/")) {
      if (type === "modify") {
        return { ...base, type: "system:modified" };
      }
    }

    // ─── Notes ────────────────────────────────────────────────
    if (path.startsWith("Notebooks/")) {
      if (type === "create") {
        return { ...base, type: "note:created" };
      }
      if (type === "modify") {
        return { ...base, type: "note:modified" };
      }
      if (type === "delete") {
        return { ...base, type: "note:deleted" };
      }
    }

    // ─── Generic file events ──────────────────────────────────
    const typeMap: Record<string, VaultEventType> = {
      create: "file:created",
      modify: "file:modified",
      delete: "file:deleted",
      rename: "file:renamed",
    };
    return {
      ...base,
      type: typeMap[type] ?? "file:modified",
    };
  }

  /** Get count of active subscriptions. */
  get subscriberCount(): number {
    let count = this.wildcardHandlers.size + this.filteredSubscriptions.size;
    for (const handlers of this.handlers.values()) {
      count += handlers.size;
    }
    return count;
  }

  /** Remove all subscriptions. */
  clear(): void {
    this.handlers.clear();
    this.wildcardHandlers.clear();
    this.filteredSubscriptions.clear();
  }

  /** Safely call a handler, catching errors to prevent cascading failures. */
  private async safeCall(
    handler: VaultEventHandler,
    event: VaultEvent,
  ): Promise<void> {
    try {
      await handler(event);
    } catch (err: any) {
      if (this.debug) {
        console.error(
          `[vault-sync:event] Handler error for ${event.type}:`,
          err.message,
        );
      }
    }
  }

  /** Check if an event matches a subscription filter. */
  private matchesFilter(event: VaultEvent, filter: WatchFilter): boolean {
    // Check event types
    if (filter.eventTypes && !filter.eventTypes.includes(event.type)) {
      return false;
    }

    // Check directory prefixes
    if (filter.directories) {
      const matchesDir = filter.directories.some((dir) =>
        event.path.startsWith(dir),
      );
      if (!matchesDir) return false;
    }

    return true;
  }
}
