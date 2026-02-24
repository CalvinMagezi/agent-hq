/**
 * @repo/agent-relay-protocol — Shared types and client SDK for Agent Relay.
 */

// Types
export type {
  AuthMessage,
  AuthAckMessage,
  PingMessage,
  PongMessage,
  JobSubmitMessage,
  JobSubmittedMessage,
  JobStatusMessage,
  JobStreamMessage,
  JobLogMessage,
  JobCompleteMessage,
  JobCancelMessage,
  ChatSendMessage,
  ChatDeltaMessage,
  ChatToolMessage,
  ChatFinalMessage,
  ChatAbortMessage,
  SystemStatusMessage,
  SystemStatusResponseMessage,
  SystemEventMessage,
  SystemAgentsMessage,
  SystemSubscribeMessage,
  CmdExecuteMessage,
  CmdResultMessage,
  TraceStatusMessage,
  TraceStatusResponseMessage,
  TraceProgressMessage,
  TraceCancelTaskMessage,
  TraceCancelTaskResultMessage,
  RelayErrorMessage,
  RelayMessage,
  RelayMessageType,
} from "./types";

// Client
export { RelayClient } from "./client";
export type { RelayClientConfig } from "./client";

// Constants
export {
  RELAY_PROTOCOL_VERSION,
  RELAY_DEFAULT_PORT,
  RELAY_DEFAULT_HOST,
  RELAY_PING_INTERVAL_MS,
  RELAY_RECONNECT_INITIAL_MS,
  RELAY_RECONNECT_MAX_MS,
  RELAY_SERVER_VERSION,
  RELAY_CLIENT_VERSION,
  RELAY_MAX_CHUNK_SIZE,
  RELAY_MAX_RESULT_SIZE,
} from "./constants";
