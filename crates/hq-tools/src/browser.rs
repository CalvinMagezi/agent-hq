//! Browser automation tools — proxy requests to hq-browser HTTP server.

use anyhow::{Result, bail};
use async_trait::async_trait;
use reqwest::Client;
use serde_json::{Value, json};

use crate::registry::HqTool;

fn base_url() -> String {
    let port = std::env::var("HQ_BROWSER_PORT").unwrap_or_else(|_| "19200".to_string());
    format!("http://127.0.0.1:{port}")
}

async fn call(
    http: &Client,
    path: &str,
    method: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let url = format!("{}{path}", base_url());
    let resp = match method {
        "POST" => {
            let mut req = http.post(&url).header("Content-Type", "application/json");
            if let Some(b) = body {
                req = req.json(b);
            }
            req.send().await?
        }
        "DELETE" => http.delete(&url).send().await?,
        _ => http.get(&url).send().await?,
    };

    let status = resp.status();
    let json: Value = resp.json().await.unwrap_or(json!({}));
    if !status.is_success() {
        let err = json.get("error").and_then(|v| v.as_str()).unwrap_or("unknown");
        bail!("hq-browser {status}: {err}");
    }
    Ok(json)
}

/// Generic browser tool that proxies to the hq-browser server.
pub struct BrowserTool {
    http: Client,
    tool_name: String,
    tool_desc: String,
    tool_params: Value,
    path: String,
    method: String,
}

impl BrowserTool {
    pub fn new(name: &str, desc: &str, params: Value, path: &str, method: &str) -> Self {
        Self {
            http: Client::new(),
            tool_name: name.to_string(),
            tool_desc: desc.to_string(),
            tool_params: params,
            path: path.to_string(),
            method: method.to_string(),
        }
    }
}

#[async_trait]
impl HqTool for BrowserTool {
    fn name(&self) -> &str { &self.tool_name }
    fn description(&self) -> &str { &self.tool_desc }
    fn parameters(&self) -> Value { self.tool_params.clone() }
    fn category(&self) -> &str { "browser" }

    async fn execute(&self, args: Value) -> Result<Value> {
        call(&self.http, &self.path, &self.method, Some(&args)).await
    }
}

/// Create all browser tools.
pub fn create_browser_tools() -> Vec<Box<dyn HqTool>> {
    vec![
        Box::new(BrowserTool::new(
            "browser_session_start", "Start a browser session",
            json!({"type":"object","properties":{"jobId":{"type":"string"}}}),
            "/sessions", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_navigate", "Navigate to a URL",
            json!({"type":"object","properties":{"sessionId":{"type":"string"},"url":{"type":"string"}},"required":["sessionId","url"]}),
            "/navigate", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_screenshot", "Take a screenshot",
            json!({"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"]}),
            "/screenshot", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_click", "Click an element",
            json!({"type":"object","properties":{"sessionId":{"type":"string"},"selector":{"type":"string"}},"required":["sessionId","selector"]}),
            "/click", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_type", "Type text into an input",
            json!({"type":"object","properties":{"sessionId":{"type":"string"},"selector":{"type":"string"},"text":{"type":"string"}},"required":["sessionId","selector","text"]}),
            "/type", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_evaluate", "Execute JavaScript in the page",
            json!({"type":"object","properties":{"sessionId":{"type":"string"},"script":{"type":"string"}},"required":["sessionId","script"]}),
            "/evaluate", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_get_content", "Get page text content",
            json!({"type":"object","properties":{"sessionId":{"type":"string"},"selector":{"type":"string"}},"required":["sessionId"]}),
            "/content", "POST",
        )),
        Box::new(BrowserTool::new(
            "browser_session_close", "Close a browser session",
            json!({"type":"object","properties":{"sessionId":{"type":"string"}},"required":["sessionId"]}),
            "/sessions", "DELETE",
        )),
    ]
}
