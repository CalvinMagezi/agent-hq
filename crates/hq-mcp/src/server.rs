//! MCP stdio server — implements the rmcp `ServerHandler` trait.

use hq_tools::registry::ToolRegistry;
use rmcp::handler::server::ServerHandler;
use rmcp::model::{
    CallToolRequestParam, CallToolResult, Implementation, ListToolsResult, PaginatedRequestParam,
    ServerCapabilities, ServerInfo,
};
use rmcp::service::{Peer, RequestContext, RoleServer};
use std::sync::Arc;

use crate::gateway;

/// The MCP server handler. Holds a shared reference to the tool registry.
#[derive(Clone)]
pub struct HqMcpServer {
    registry: Arc<ToolRegistry>,
    peer: Option<Peer<RoleServer>>,
}

impl HqMcpServer {
    pub fn new(registry: Arc<ToolRegistry>) -> Self {
        Self {
            registry,
            peer: None,
        }
    }

    /// Start serving over stdin/stdout using the rmcp transport.
    pub async fn serve_stdio(self) -> anyhow::Result<()> {
        let transport = rmcp::transport::stdio();
        let server = rmcp::serve_server(self, transport).await?;
        server.waiting().await?;
        Ok(())
    }
}

impl ServerHandler for HqMcpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo {
            protocol_version: Default::default(),
            capabilities: ServerCapabilities::builder()
                .enable_tools()
                .build(),
            server_info: Implementation {
                name: "agent-hq".to_string(),
                version: "0.1.0".to_string(),
            },
            instructions: Some(
                "Agent-HQ MCP server. Use hq_discover to browse tools, hq_call to invoke them."
                    .to_string(),
            ),
        }
    }

    fn get_peer(&self) -> Option<Peer<RoleServer>> {
        self.peer.clone()
    }

    fn set_peer(&mut self, peer: Peer<RoleServer>) {
        self.peer = Some(peer);
    }

    fn list_tools(
        &self,
        _request: PaginatedRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<ListToolsResult, rmcp::Error>> + Send + '_ {
        async move {
            Ok(ListToolsResult {
                next_cursor: None,
                tools: gateway::create_gateway_tools(),
            })
        }
    }

    fn call_tool(
        &self,
        request: CallToolRequestParam,
        _context: RequestContext<RoleServer>,
    ) -> impl std::future::Future<Output = Result<CallToolResult, rmcp::Error>> + Send + '_ {
        async move {
            match request.name.as_ref() {
                "hq_discover" => {
                    gateway::handle_discover(&self.registry, request.arguments.as_ref())
                }
                "hq_call" => {
                    gateway::handle_call(&self.registry, request.arguments.as_ref()).await
                }
                other => Err(rmcp::Error::invalid_params(
                    format!("unknown tool: {other}. Use hq_discover or hq_call."),
                    None,
                )),
            }
        }
    }
}
