/**
 * Transport — WebSocket connection to the sync relay server.
 *
 * Handles connection, reconnection, E2E encryption, and message routing.
 */

import type {
  SyncMessage,
  WireMessage,
  HelloMessage,
  DeltaPushMessage,
  SyncChangeEntry,
} from "@repo/vault-sync-protocol";
import {
  deriveVaultKey,
  generateVaultId,
  wrapMessage,
  unwrapMessage,
  serializeWireMessage,
  deserializeWireMessage,
  PROTOCOL_VERSION,
  CAPABILITIES,
  CLIENT_VERSION,
  PING_INTERVAL_MS,
  RECONNECT_INITIAL_MS,
  RECONNECT_MAX_MS,
} from "@repo/vault-sync-protocol";
import type { VaultSyncSettings, SyncStatus } from "./types";

export type MessageHandler = (message: SyncMessage) => void;
export type StatusHandler = (status: SyncStatus) => void;

export class SyncTransport {
  private ws: WebSocket | null = null;
  private encryptionKey: CryptoKey | null = null;
  private vaultId: string = "";
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = RECONNECT_INITIAL_MS;
  private intentionallyClosed = false;
  private onMessage: MessageHandler | null = null;
  private onStatus: StatusHandler | null = null;

  constructor(private settings: VaultSyncSettings) {}

  /**
   * Initialize encryption key and vault ID from passphrase.
   */
  async init(): Promise<void> {
    if (this.settings.encryptionPassphrase) {
      // Derive a passphrase-specific salt via SHA-256 so different passphrases
      // produce different salts (prevents cross-user precomputation), while all
      // devices using the same passphrase arrive at the same key.
      const passphraseBytes = new TextEncoder().encode(
        this.settings.encryptionPassphrase + "agent-hq-vault-sync-v1",
      );
      const saltHashBuf = await globalThis.crypto.subtle.digest(
        "SHA-256",
        passphraseBytes,
      );
      const saltHex = Array.from(new Uint8Array(saltHashBuf))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");

      const key = await deriveVaultKey(this.settings.encryptionPassphrase, saltHex);
      this.vaultId = await generateVaultId(key);
      this.encryptionKey = this.settings.enableE2E ? key : null;
    } else {
      this.encryptionKey = null;
      this.vaultId = "unencrypted-vault";
    }
  }

  /**
   * Set message and status handlers.
   */
  onMessages(handler: MessageHandler): void {
    this.onMessage = handler;
  }

  onStatusChange(handler: StatusHandler): void {
    this.onStatus = handler;
  }

  /**
   * Connect to the relay server.
   */
  async connect(): Promise<void> {
    if (this.ws) return;
    this.intentionallyClosed = false;

    await this.init();
    this.emitStatus("connecting");

    try {
      this.ws = new WebSocket(this.settings.serverUrl);

      this.ws.onopen = () => {
        this.reconnectDelay = RECONNECT_INITIAL_MS;
        this.sendHello();
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        this.handleRawMessage(event.data as string);
      };

      this.ws.onclose = () => {
        this.cleanup();
        if (!this.intentionallyClosed) {
          this.emitStatus("disconnected");
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        this.emitStatus("error");
      };
    } catch {
      this.emitStatus("error");
      this.scheduleReconnect();
    }
  }

  /**
   * Disconnect from the server.
   */
  disconnect(): void {
    this.intentionallyClosed = true;
    this.cleanup();
    this.emitStatus("disconnected");
  }

  /**
   * Send a sync message (encrypted if E2E is enabled).
   */
  async send(message: SyncMessage): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const wire = await wrapMessage(message, this.encryptionKey);
    this.ws.send(serializeWireMessage(wire));
  }

  /**
   * Send a delta-push for a local change.
   */
  async pushChange(change: SyncChangeEntry): Promise<void> {
    const msg: DeltaPushMessage = {
      type: "delta-push",
      fromDeviceId: this.settings.deviceId!,
      change,
    };
    await this.send(msg);
  }

  /**
   * Request index catchup from peers.
   */
  async requestIndex(sinceChangeId: number, batchSize = 500): Promise<void> {
    await this.send({
      type: "index-request",
      sinceChangeId,
      batchSize,
    });
  }

  /**
   * Request file content from a specific device.
   */
  async requestFile(
    path: string,
    contentHash: string,
    targetDeviceId: string,
  ): Promise<void> {
    await this.send({
      type: "file-request",
      path,
      contentHash,
      targetDeviceId,
      fromDeviceId: this.settings.deviceId!,
    });
  }

  /**
   * Whether the transport is connected and authenticated.
   */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  get currentVaultId(): string {
    return this.vaultId;
  }

  // ─── Internal ─────────────────────────────────────────────

  private sendHello(): void {
    const hello: HelloMessage = {
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      deviceId: this.settings.deviceId!,
      deviceName: this.settings.deviceName || "Unknown Device",
      vaultId: this.vaultId,
      capabilities: [...CAPABILITIES],
      clientVersion: CLIENT_VERSION,
      deviceToken: this.settings.deviceToken,
    };

    // Hello is never encrypted (plaintext whitelist)
    const wire = serializeWireMessage({
      encrypted: false,
      payload: hello,
    });
    this.ws?.send(wire);
  }

  private async handleRawMessage(data: string): Promise<void> {
    try {
      const wire = deserializeWireMessage(data);
      const message = await unwrapMessage(wire, this.encryptionKey);

      // Handle hello-ack internally
      if (message.type === "hello-ack") {
        this.settings.deviceToken = (message as any).assignedToken;
        this.emitStatus("synced");
      }

      // Forward to handler
      if (this.onMessage) {
        this.onMessage(message);
      }
    } catch (err) {
      if (this.settings.debug) {
        console.error("[vault-sync] Failed to process message:", err);
      }
    }
  }

  private startPing(): void {
    this.pingInterval = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        const wire = serializeWireMessage({
          encrypted: false,
          payload: { type: "ping" as const, timestamp: Date.now() },
        });
        this.ws.send(wire);
      }
    }, PING_INTERVAL_MS);
  }

  private cleanup(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Ignore close errors
      }
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(
      this.reconnectDelay * 2,
      RECONNECT_MAX_MS,
    );
  }

  private emitStatus(status: SyncStatus): void {
    if (this.onStatus) {
      this.onStatus(status);
    }
  }
}
