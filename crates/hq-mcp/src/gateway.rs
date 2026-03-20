//! 2-tool gateway pattern — keeps MCP token footprint to ~1K regardless of registry size.
//!
//! Exposes exactly two MCP tools:
//! - `hq_discover` — browse available tools by category/query
//! - `hq_call` — invoke any registered tool by name

use hq_tools::registry::ToolRegistry;
use rmcp::model::{CallToolResult, Content, Tool};
use serde::Deserialize;
use serde_json::{Value, json};

/// Parameters for the `hq_discover` tool.
#[derive(Debug, Deserialize)]
struct DiscoverArgs {
    category: Option<String>,
    query: Option<String>,
}

/// Parameters for the `hq_call` tool.
#[derive(Debug, Deserialize)]
struct CallArgs {
    tool: String,
    args: Option<Value>,
}

/// Build the two MCP `Tool` definitions for the gateway.
pub fn create_gateway_tools() -> Vec<Tool> {
    let discover_schema = json!({
        "type": "object",
        "properties": {
            "category": {
                "type": "string",
                "description": "Filter by category (vault, skills, agents, workspace, general)"
            },
            "query": {
                "type": "string",
                "description": "Free-text search across tool names and descriptions"
            }
        },
        "required": []
    });

    let call_schema = json!({
        "type": "object",
        "properties": {
            "tool": {
                "type": "string",
                "description": "Name of the tool to call (from hq_discover results)"
            },
            "args": {
                "type": "object",
                "description": "Arguments to pass to the tool (see tool's parameter schema)"
            }
        },
        "required": ["tool"]
    });

    vec![
        Tool::new(
            "hq_discover",
            "Discover available Agent-HQ tools. Returns names, descriptions, categories, and parameter schemas. Use category and/or query to filter.",
            rmcp::model::object(discover_schema),
        ),
        Tool::new(
            "hq_call",
            "Call any Agent-HQ tool by name with arguments. Use hq_discover first to find available tools and their parameter schemas.",
            rmcp::model::object(call_schema),
        ),
    ]
}

/// Handle the `hq_discover` tool call.
pub fn handle_discover(
    registry: &ToolRegistry,
    arguments: Option<&serde_json::Map<String, Value>>,
) -> Result<CallToolResult, rmcp::Error> {
    let args: DiscoverArgs = if let Some(obj) = arguments {
        serde_json::from_value(Value::Object(obj.clone())).map_err(|e| {
            rmcp::Error::invalid_params(format!("invalid discover args: {e}"), None)
        })?
    } else {
        DiscoverArgs {
            category: None,
            query: None,
        }
    };

    let results = registry.discover(args.category.as_deref(), args.query.as_deref());

    let json_str = serde_json::to_string_pretty(&results).unwrap_or_else(|_| "[]".to_string());

    Ok(CallToolResult::success(vec![Content::text(json_str)]))
}

/// Handle the `hq_call` tool call.
pub async fn handle_call(
    registry: &ToolRegistry,
    arguments: Option<&serde_json::Map<String, Value>>,
) -> Result<CallToolResult, rmcp::Error> {
    let obj = arguments.ok_or_else(|| {
        rmcp::Error::invalid_params("hq_call requires arguments", None)
    })?;

    let args: CallArgs =
        serde_json::from_value(Value::Object(obj.clone())).map_err(|e| {
            rmcp::Error::invalid_params(format!("invalid call args: {e}"), None)
        })?;

    let tool = registry.get(&args.tool).ok_or_else(|| {
        rmcp::Error::invalid_params(format!("unknown tool: {}", args.tool), None)
    })?;

    let tool_args = args.args.unwrap_or(json!({}));

    match tool.execute(tool_args).await {
        Ok(result) => {
            let text = serde_json::to_string_pretty(&result)
                .unwrap_or_else(|_| result.to_string());
            Ok(CallToolResult::success(vec![Content::text(text)]))
        }
        Err(e) => Ok(CallToolResult::error(vec![Content::text(format!(
            "tool error: {e}"
        ))])),
    }
}
