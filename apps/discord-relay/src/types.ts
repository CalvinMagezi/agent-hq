export interface SessionState {
  sessionId: string | null;
  lastActivity: string;
  channelId: string;
}

export interface SessionStore {
  sessions: Record<string, SessionState>;
}

export interface RelayConfig {
  discordBotToken: string;
  discordUserId: string;
  discordBotId?: string;
  claudePath: string;
  projectDir: string;
  relayDir: string;
  convexUrl: string;
  convexSiteUrl: string;
  apiKey: string;
  vaultPath?: string;
  uploadsDir: string;
  userName?: string;
  timezone: string;
  voiceProvider: "groq" | "whisper" | "none";
  groqApiKey?: string;
  whisperPath?: string;
  whisperModel?: string;
}

export interface ConvexNote {
  noteId: string;
  title: string;
  content: string;
  notebook?: string;
  tags: string[];
  relevance?: number;
}

export interface MemoryFact {
  type: "fact" | "goal" | "completed_goal";
  content: string;
  deadline?: string;
  createdAt: number;
}

/** Per-channel CLI settings (model, effort, etc.) — shared across harnesses */
export interface ChannelSettings {
  model?: string;
  effort?: "low" | "medium" | "high";
  systemPrompt?: string;
  allowedTools?: string[];
  addDirs?: string[];
  maxBudget?: number;
  /** OpenCode-only: agent to use */
  agent?: string;
}

/** Result from a command handler (prefix ! or slash /) */
export interface CommandResult {
  handled: boolean;
  response?: string;
  embed?: import("discord.js").EmbedBuilder;
  file?: { name: string; buffer: Buffer };
}

/** Claude CLI options passed alongside the prompt */
export interface ClaudeCallOptions {
  filePaths?: string[];
  channelSettings?: ChannelSettings;
  continueSession?: boolean;
}

/** Security constraints passed from HQ orchestrator to relay bots */
export interface DelegationSecurityConstraints {
  blockedCommands?: string[];
  filesystemAccess?: "full" | "read-only" | "restricted";
  allowedDirectories?: string[];
  noGit?: boolean;
  noNetwork?: boolean;
  maxExecutionMs?: number;
}

/** A task delegated from HQ orchestrator to a relay bot */
export interface DelegatedTask {
  _id: string;
  taskId: string;
  jobId: string;
  instruction: string;
  targetHarnessType: string;
  targetRelayId?: string;
  status: string;
  priority?: number;
  modelOverride?: string;
  discordChannelId?: string;
  dependsOn?: string[];
  createdAt: number;
  /** Trace context — set by HQ when orchestrating */
  traceId?: string;
  spanId?: string;
  securityConstraints?: DelegationSecurityConstraints;
}
