/**
 * gwsClient — Google Chat API client using service account credentials.
 *
 * Google Chat API requires a registered "Chat App" — unlike Drive/Gmail,
 * user OAuth alone isn't enough. We use a service account JSON key file
 * to authenticate, which also gives the bot its own identity in Chat.
 *
 * The service account must be configured as the Chat App's credential
 * in Google Cloud Console → Google Chat API → Configuration.
 */

import { readFileSync } from "node:fs";
import { SignJWT, importPKCS8 } from "jose";

// ─── Types ───────────────────────────────────────────────────────

export interface ChatSpace {
  name: string;           // e.g. "spaces/AAAAxxxx"
  displayName?: string;
  type?: string;          // "ROOM", "DM", "GROUP_DM"
  singleUserBotDm?: boolean;
}

export interface ChatMessage {
  name: string;           // e.g. "spaces/xxx/messages/yyy"
  sender: {
    name: string;         // e.g. "users/123456789"
    displayName?: string;
    type?: string;        // "HUMAN", "BOT"
  };
  text?: string;
  createTime: string;     // ISO 8601
  thread?: {
    name: string;
    threadKey?: string;
  };
  space?: {
    name: string;
  };
}

export interface ChatEvent {
  type: string;           // "MESSAGE", "ADDED_TO_SPACE", "REMOVED_FROM_SPACE"
  eventTime: string;
  message?: ChatMessage;
  user?: {
    name: string;
    displayName?: string;
    type?: string;
  };
  space?: ChatSpace;
}

interface ListResponse<T> {
  spaces?: T[];
  messages?: T[];
  nextPageToken?: string;
}

interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
  auth_uri: string;
  token_uri: string;
}

// ─── Auth ────────────────────────────────────────────────────────

const CHAT_SCOPE = "https://www.googleapis.com/auth/chat.bot";
const CHAT_API_BASE = "https://chat.googleapis.com/v1";

let cachedToken: { token: string; expiresAt: number } | null = null;
let serviceAccountKey: ServiceAccountKey | null = null;

/** Load service account key from file path. */
export function loadServiceAccount(keyFilePath: string): void {
  const raw = readFileSync(keyFilePath, "utf-8");
  serviceAccountKey = JSON.parse(raw) as ServiceAccountKey;
}

/** Get a valid access token, refreshing if needed. */
async function getAccessToken(): Promise<string> {
  if (!serviceAccountKey) {
    throw new Error(
      "Service account not loaded. Call loadServiceAccount() first.",
    );
  }

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const now = Math.floor(Date.now() / 1000);
  const key = await importPKCS8(serviceAccountKey.private_key, "RS256");

  const jwt = await new SignJWT({
    scope: CHAT_SCOPE,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuer(serviceAccountKey.client_email)
    .setSubject(serviceAccountKey.client_email)
    .setAudience(serviceAccountKey.token_uri)
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(key);

  const resp = await fetch(serviceAccountKey.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${err}`);
  }

  const data = (await resp.json()) as { access_token: string; expires_in: number };
  cachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };

  return cachedToken.token;
}

/** Make an authenticated request to the Chat API. */
async function chatFetch(path: string, options?: RequestInit): Promise<Response> {
  const token = await getAccessToken();
  const resp = await fetch(`${CHAT_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Chat API error (${resp.status}): ${err}`);
  }

  return resp;
}

// ─── API Functions ───────────────────────────────────────────────

/** List all spaces the bot is in. */
export async function listSpaces(): Promise<ChatSpace[]> {
  const resp = await chatFetch("/spaces?pageSize=100");
  const data = (await resp.json()) as ListResponse<ChatSpace>;
  return data.spaces ?? [];
}

/** List recent messages in a space. */
export async function listMessages(
  spaceName: string,
  pageSize = 10,
): Promise<ChatMessage[]> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: "createTime desc",
  });
  const resp = await chatFetch(`/${spaceName}/messages?${params}`);
  const data = (await resp.json()) as ListResponse<ChatMessage>;
  return data.messages ?? [];
}

/** Send a text message to a space. Returns the created message. */
export async function createMessage(
  spaceName: string,
  text: string,
  threadKey?: string,
): Promise<ChatMessage> {
  const body: Record<string, unknown> = { text };
  if (threadKey) {
    body.thread = { threadKey };
  }

  const resp = await chatFetch(`/${spaceName}/messages`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return (await resp.json()) as ChatMessage;
}

/** Update an existing message's text. For progressive response updates. */
export async function updateMessage(
  messageName: string,
  text: string,
): Promise<ChatMessage> {
  const resp = await chatFetch(`/${messageName}?updateMask=text`, {
    method: "PATCH",
    body: JSON.stringify({ text }),
  });

  return (await resp.json()) as ChatMessage;
}
