//! Vault sync protocol wire types.
//!
//! These types define the messages exchanged between devices for
//! real-time vault synchronization.

use serde::{Deserialize, Serialize};

use crate::crypto::EncryptedEnvelope;

// ─── Change Entries ─────────────────────────────────────────────

/// The fundamental change unit transmitted between devices.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncChangeEntry {
    pub change_id: i64,
    pub path: String,
    #[serde(default)]
    pub old_path: Option<String>,
    pub change_type: ChangeType,
    pub content_hash: Option<String>,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub detected_at: i64,
    pub device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum ChangeType {
    Create,
    Modify,
    Delete,
    Rename,
}

// ─── Handshake ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloMessage {
    pub protocol_version: u8,
    pub device_id: String,
    pub device_name: String,
    pub vault_id: String,
    pub capabilities: Vec<String>,
    pub client_version: String,
    #[serde(default)]
    pub device_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAckMessage {
    pub device_id: String,
    pub server_version: String,
    #[serde(default)]
    pub assigned_token: Option<String>,
    pub connected_devices: Vec<String>,
}

// ─── Index Exchange ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRequestMessage {
    pub since_change_id: i64,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexResponseMessage {
    pub from_device_id: String,
    pub changes: Vec<SyncChangeEntry>,
    pub has_more: bool,
    pub latest_change_id: i64,
}

// ─── Real-time Deltas ───────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaPushMessage {
    pub from_device_id: String,
    pub change: SyncChangeEntry,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeltaAckMessage {
    pub change_id: i64,
    pub from_device_id: String,
}

// ─── File Transfer ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileRequestMessage {
    pub path: String,
    pub content_hash: String,
    pub target_device_id: String,
    pub from_device_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileResponseMessage {
    pub path: String,
    pub content_hash: String,
    /// Base64-encoded file content
    pub content: String,
    pub size: u64,
    pub mtime: i64,
    pub from_device_id: String,
}

// ─── Device Pairing ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairRequestMessage {
    pub device_id: String,
    pub device_name: String,
    pub pairing_code_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PairConfirmMessage {
    pub device_id: String,
    pub approved: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceListMessage {
    pub devices: Vec<DeviceInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub device_id: String,
    pub device_name: String,
    pub last_seen: i64,
    pub status: DeviceStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DeviceStatus {
    Online,
    Offline,
}

// ─── Transport ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingMessage {
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PongMessage {
    pub timestamp: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorMessage {
    pub code: String,
    pub message: String,
}

/// Wire message — either encrypted or plaintext.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireMessage {
    pub encrypted: bool,
    pub payload: WirePayload,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum WirePayload {
    Encrypted(EncryptedEnvelope),
    Plain(SyncMessage),
}

/// Union of all sync protocol messages.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SyncMessage {
    Hello(HelloMessage),
    HelloAck(HelloAckMessage),
    IndexRequest(IndexRequestMessage),
    IndexResponse(IndexResponseMessage),
    DeltaPush(DeltaPushMessage),
    DeltaAck(DeltaAckMessage),
    FileRequest(FileRequestMessage),
    FileResponse(FileResponseMessage),
    PairRequest(PairRequestMessage),
    PairConfirm(PairConfirmMessage),
    DeviceList(DeviceListMessage),
    Ping(PingMessage),
    Pong(PongMessage),
    Error(ErrorMessage),
}
