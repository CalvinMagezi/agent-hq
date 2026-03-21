//! NDJSON text extraction for CLI harness output streams.

/// Extract text from an NDJSON line emitted by CLI harnesses.
///
/// Supported formats:
/// - Claude Code: `{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}`
/// - Claude Code result: `{"type":"result","result":"..."}`
/// - Content block delta: `{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}`
/// - Codex: `{"type":"message","content":"..."}`
/// - Simple: `{"text":"..."}` or `{"content":"..."}`
pub fn extract_text_from_ndjson(json: &serde_json::Value) -> Option<String> {
    let msg_type = json.get("type").and_then(|v| v.as_str()).unwrap_or("");

    // Claude Code: {"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}
    if msg_type == "assistant" {
        // Try message.content[] (Claude Code stream-json format)
        if let Some(msg) = json.get("message") {
            if let Some(content) = msg.get("content").and_then(|v| v.as_array()) {
                let text = extract_text_blocks(content);
                if !text.is_empty() {
                    return Some(text);
                }
            }
        }
        // Also try direct content[] (older format)
        if let Some(content) = json.get("content").and_then(|v| v.as_array()) {
            let text = extract_text_blocks(content);
            if !text.is_empty() {
                return Some(text);
            }
        }
    }

    // Claude Code result: {"type":"result","result":"..."}
    if msg_type == "result" {
        if let Some(t) = json.get("result").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }

    // Content block delta: {"type":"content_block_delta","delta":{"text":"..."}}
    if msg_type == "content_block_delta" {
        if let Some(delta) = json.get("delta") {
            if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                return Some(t.to_string());
            }
        }
    }

    // Codex: {"type":"message","content":"..."}
    if msg_type == "message" {
        if let Some(t) = json.get("content").and_then(|v| v.as_str()) {
            return Some(t.to_string());
        }
    }

    // Simple text field
    if let Some(t) = json.get("text").and_then(|v| v.as_str()) {
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }

    None
}

/// Extract and concatenate text blocks from a content array.
fn extract_text_blocks(content: &[serde_json::Value]) -> String {
    let mut text = String::new();
    for block in content {
        if block.get("type").and_then(|v| v.as_str()) == Some("text") {
            if let Some(t) = block.get("text").and_then(|v| v.as_str()) {
                text.push_str(t);
            }
        }
    }
    text
}
