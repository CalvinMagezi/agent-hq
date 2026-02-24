/**
 * Tests for relay protocol types and message serialization.
 */

import { describe, test, expect } from "bun:test";
import type {
  AuthMessage,
  AuthAckMessage,
  JobSubmitMessage,
  JobSubmittedMessage,
  JobCompleteMessage,
  ChatSendMessage,
  ChatFinalMessage,
  SystemStatusResponseMessage,
  RelayMessage,
} from "../types";
import {
  RELAY_DEFAULT_PORT,
  RELAY_DEFAULT_HOST,
  RELAY_PROTOCOL_VERSION,
  RELAY_SERVER_VERSION,
} from "../constants";

// ─── Constants ──────────────────────────────────────────────────────────

describe("constants", () => {
  test("default port is 18900", () => {
    expect(RELAY_DEFAULT_PORT).toBe(18900);
  });

  test("default host is 127.0.0.1", () => {
    expect(RELAY_DEFAULT_HOST).toBe("127.0.0.1");
  });

  test("protocol version is 1", () => {
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
  });

  test("server version is a semver string", () => {
    expect(RELAY_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

// ─── Message serialization ───────────────────────────────────────────────

describe("message serialization", () => {
  test("auth message round-trips through JSON", () => {
    const msg: AuthMessage = {
      type: "auth",
      apiKey: "test-key-123",
      clientId: "test-client",
      clientType: "cli",
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as AuthMessage;
    expect(parsed.type).toBe("auth");
    expect(parsed.apiKey).toBe("test-key-123");
    expect(parsed.clientId).toBe("test-client");
    expect(parsed.clientType).toBe("cli");
  });

  test("auth-ack message round-trips through JSON", () => {
    const msg: AuthAckMessage = {
      type: "auth-ack",
      success: true,
      sessionToken: "sess-123",
      serverVersion: "0.1.0",
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as AuthAckMessage;
    expect(parsed.type).toBe("auth-ack");
    expect(parsed.success).toBe(true);
    expect(parsed.sessionToken).toBe("sess-123");
  });

  test("job:submit message round-trips", () => {
    const msg: JobSubmitMessage = {
      type: "job:submit",
      instruction: "Write a test",
      jobType: "background",
      priority: 75,
      securityProfile: "standard",
      requestId: "req-001",
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as JobSubmitMessage;
    expect(parsed.type).toBe("job:submit");
    expect(parsed.instruction).toBe("Write a test");
    expect(parsed.priority).toBe(75);
    expect(parsed.requestId).toBe("req-001");
  });

  test("job:complete message carries result", () => {
    const msg: JobCompleteMessage = {
      type: "job:complete",
      jobId: "job-abc",
      status: "done",
      result: "Task completed successfully",
      completedAt: new Date().toISOString(),
    };
    const json = JSON.stringify(msg);
    const parsed = JSON.parse(json) as JobCompleteMessage;
    expect(parsed.type).toBe("job:complete");
    expect(parsed.status).toBe("done");
    expect(parsed.result).toBe("Task completed successfully");
  });

  test("chat:send message round-trips", () => {
    const msg: ChatSendMessage = {
      type: "chat:send",
      content: "Hello, how are you?",
      threadId: "thread-xyz",
      requestId: "chat-001",
    };
    const parsed = JSON.parse(JSON.stringify(msg)) as ChatSendMessage;
    expect(parsed.type).toBe("chat:send");
    expect(parsed.content).toBe("Hello, how are you?");
    expect(parsed.threadId).toBe("thread-xyz");
  });

  test("chat:final message carries complete content", () => {
    const msg: ChatFinalMessage = {
      type: "chat:final",
      requestId: "chat-001",
      threadId: "thread-xyz",
      content: "I am doing well, thank you!",
    };
    const parsed = JSON.parse(JSON.stringify(msg)) as ChatFinalMessage;
    expect(parsed.content).toBe("I am doing well, thank you!");
  });

  test("system:status-response has all required fields", () => {
    const msg: SystemStatusResponseMessage = {
      type: "system:status-response",
      status: "healthy",
      agentOnline: true,
      pendingJobs: 2,
      runningJobs: 1,
      connectedClients: 3,
      vaultPath: "/path/to/vault",
      serverVersion: "0.1.0",
      uptime: 3600,
    };
    const parsed = JSON.parse(JSON.stringify(msg)) as SystemStatusResponseMessage;
    expect(parsed.status).toBe("healthy");
    expect(parsed.agentOnline).toBe(true);
    expect(parsed.pendingJobs).toBe(2);
    expect(parsed.uptime).toBe(3600);
  });

  test("discriminated union — type field narrows correctly", () => {
    const messages: RelayMessage[] = [
      { type: "ping", timestamp: Date.now() },
      { type: "pong", timestamp: Date.now() },
      { type: "error", code: "TEST_ERROR", message: "test" },
    ];

    for (const msg of messages) {
      expect(msg.type).toBeDefined();
      const json = JSON.stringify(msg);
      const parsed = JSON.parse(json) as RelayMessage;
      expect(parsed.type).toBe(msg.type);
    }
  });
});
