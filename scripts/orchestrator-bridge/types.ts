/** Bridge-specific TypeScript interfaces for the OpenClaw integration */

export interface BridgeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

export interface BridgeResponse {
  status: number;
  body: unknown;
}

export interface CapabilityRequestBody {
  capability: string;
  instruction: string;
  priority?: number;
}

export interface NoteCreateBody {
  title: string;
  content: string;
  tags?: string[];
}

export interface NoteUpdateBody {
  content?: string;
  tags?: string[];
}

export interface HeartbeatBody {
  version?: string;
  gatewayPort?: number;
  activeChannels?: string[];
}

export interface AuditEntry {
  timestamp: string;
  action: string;
  details: Record<string, unknown>;
  status: "accepted" | "rejected" | "error" | "blocked";
}

export interface DelegateBody {
  instruction: string;
  targetAgentId: string;
  priority?: number;
  dependsOn?: string[];
  metadata?: Record<string, any>;
}

export interface CompletedBody {
  taskId: string;
  result?: string;
  error?: string;
  status?: "completed" | "failed";
}
