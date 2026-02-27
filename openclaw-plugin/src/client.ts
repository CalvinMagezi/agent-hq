/**
 * HTTP client for the Agent-HQ Bridge API.
 *
 * All requests include the bearer token and handle common errors.
 */

export interface ClientConfig {
  bridgeUrl: string;
  token: string;
}

export interface CapabilityRequestResult {
  requestId: string;
  status: string;
  message?: string;
}

export interface CapabilityStatusResult {
  requestId: string;
  status: string;
  result?: string;
  error?: string;
}

export interface NoteResult {
  title: string;
  content: string;
  tags: string[];
  createdAt: string;
  _filePath: string;
}

export interface NoteListItem {
  title: string;
  tags: string[];
  path: string;
  createdAt: string;
}

export interface SearchResult {
  title: string;
  snippet: string;
  path: string;
}

export interface ContextResult {
  currentTime: string;
  timezone: string;
}

export class AgentHQClient {
  private baseUrl: string;
  private token: string;

  constructor(config: ClientConfig) {
    this.baseUrl = config.bridgeUrl.replace(/\/$/, "");
    this.token = config.token;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => ({
        error: `HTTP ${response.status}`,
      }));
      throw new Error(
        `Bridge API error (${response.status}): ${(errorBody as { error?: string }).error ?? "Unknown error"}`,
      );
    }

    return response.json() as Promise<T>;
  }

  // ─── Heartbeat ──────────────────────────────────────────────

  async heartbeat(metadata?: {
    version?: string;
    gatewayPort?: number;
    activeChannels?: string[];
  }): Promise<void> {
    await this.request("POST", "/api/heartbeat", metadata ?? {});
  }

  // ─── Capabilities ───────────────────────────────────────────

  async requestCapability(params: {
    capability: string;
    instruction: string;
    priority?: number;
  }): Promise<CapabilityRequestResult> {
    return this.request<CapabilityRequestResult>(
      "POST",
      "/api/capabilities/request",
      params,
    );
  }

  async getCapabilityResult(
    requestId: string,
  ): Promise<CapabilityStatusResult> {
    return this.request<CapabilityStatusResult>(
      "GET",
      `/api/capabilities/${encodeURIComponent(requestId)}/status`,
    );
  }

  // ─── Notes ──────────────────────────────────────────────────

  async listNotes(): Promise<{ notes: NoteListItem[] }> {
    return this.request<{ notes: NoteListItem[] }>("GET", "/api/notes");
  }

  async readNote(notePath: string): Promise<NoteResult> {
    return this.request<NoteResult>(
      "GET",
      `/api/notes/${encodeURIComponent(notePath)}`,
    );
  }

  async writeNote(params: {
    title: string;
    content: string;
    tags?: string[];
  }): Promise<{ status: string; path: string }> {
    return this.request<{ status: string; path: string }>(
      "POST",
      "/api/notes",
      params,
    );
  }

  async updateNote(
    notePath: string,
    params: { content?: string; tags?: string[] },
  ): Promise<{ status: string; path: string }> {
    return this.request<{ status: string; path: string }>(
      "PUT",
      `/api/notes/${encodeURIComponent(notePath)}`,
      params,
    );
  }

  async deleteNote(notePath: string): Promise<{ status: string }> {
    return this.request<{ status: string }>(
      "DELETE",
      `/api/notes/${encodeURIComponent(notePath)}`,
    );
  }

  async searchNotes(
    query: string,
    limit = 5,
  ): Promise<{ results: SearchResult[] }> {
    return this.request<{ results: SearchResult[] }>(
      "GET",
      `/api/notes/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    );
  }

  // ─── Context ────────────────────────────────────────────────

  async getContext(): Promise<ContextResult> {
    return this.request<ContextResult>("GET", "/api/context");
  }

  // ─── Orchestration (COO) ───────────────────────────────────

  async listAgents(): Promise<{ agents: Array<{ id: string; name: string; description: string }> }> {
    return this.request<{ agents: Array<{ id: string; name: string; description: string }> }>("GET", "/api/agents");
  }

  async listAvailableAgents(): Promise<{
    agents: Array<{ id: string; name: string; description: string }>;
  }> {
    return this.request<{ agents: Array<{ id: string; name: string; description: string }> }>(
      "GET",
      "/api/agents",
    );
  }

  async delegateTask(params: {
    instruction: string;
    targetAgentId: string;
    priority?: number;
    dependsOn?: string[];
    metadata?: Record<string, any>;
  }): Promise<{ status: string; taskId: string }> {
    return this.request<{ status: string; taskId: string }>("POST", "/api/delegate", params);
  }

  async reviewCompletedTasks(limit = 20): Promise<{
    tasks: Array<{
      taskId: string;
      status: string;
      result?: string;
      error?: string;
      completedAt?: string;
    }>;
  }> {
    return this.request<{
      tasks: Array<{ taskId: string; status: string; result?: string; error?: string; completedAt?: string }>;
    }>("GET", `/api/completed?limit=${limit}`);
  }

  async markCompleted(params: {
    taskId: string;
    result?: string;
    error?: string;
    status?: "completed" | "failed";
  }): Promise<{ status: string }> {
    return this.request<{ status: string }>("POST", "/api/completed", params);
  }

  // ─── Health ─────────────────────────────────────────────────

  async checkHealth(): Promise<{
    status: string;
    circuitBreaker: string;
    timestamp: string;
  }> {
    // Health endpoint doesn't require auth
    const url = `${this.baseUrl}/api/health`;
    const response = await fetch(url);
    return response.json() as Promise<{
      status: string;
      circuitBreaker: string;
      timestamp: string;
    }>;
  }
}
