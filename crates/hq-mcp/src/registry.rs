//! MCP tool registry setup — instantiates all built-in tools.

use hq_db::Database;
use hq_tools::registry::ToolRegistry;
use hq_tools::{agents, benchmark, browser, drawit, gws, imagegen, planning, skills, tts, vault, webmail, workflow};
use hq_vault::VaultClient;
use std::path::PathBuf;
use std::sync::Arc;

/// Create the default tool registry with all built-in tools.
///
/// `vault_client` — for vault read/write/list operations.
/// `db` — for FTS search operations.
/// `skills_dir` — path to the skills directory (e.g. `packages/hq-tools/skills/`).
/// `agents_dir` — path to the agents directory (e.g. `packages/hq-tools/agents/`).
pub fn create_default_registry(
    vault_client: Arc<VaultClient>,
    db: Arc<Database>,
    skills_dir: PathBuf,
    agents_dir: PathBuf,
) -> ToolRegistry {
    let mut registry = ToolRegistry::new();

    let vault_path = vault_client.vault_path().to_path_buf();

    // Vault tools (7)
    registry.register(Box::new(vault::VaultSearchTool::new(db.clone())));
    registry.register(Box::new(vault::VaultReadTool::new(vault_client.clone())));
    registry.register(Box::new(vault::VaultContextTool::new(vault_client.clone())));
    registry.register(Box::new(vault::VaultListTool::new(vault_client.clone())));
    registry.register(Box::new(vault::VaultBatchReadTool::new(vault_client.clone())));
    registry.register(Box::new(vault::VaultWriteNoteTool::new(vault_client.clone())));
    registry.register(Box::new(vault::VaultCreateJobTool::new(vault_client)));

    // Skill tools (2)
    registry.register(Box::new(skills::ListSkillsTool::new(skills_dir.clone())));
    registry.register(Box::new(skills::LoadSkillTool::new(skills_dir)));

    // Agent tools (2)
    registry.register(Box::new(agents::ListAgentsTool::new(agents_dir.clone())));
    registry.register(Box::new(agents::LoadAgentTool::new(agents_dir)));

    // Google Workspace tool (1)
    registry.register(Box::new(gws::GoogleWorkspaceTool::new()));

    // Image generation tool (1)
    registry.register(Box::new(imagegen::ImageGenTool::new(vault_path.clone())));

    // Text-to-speech tool (1)
    registry.register(Box::new(tts::SpeakTool::new(vault_path.clone())));

    // DrawIt diagram tools (6)
    registry.register(Box::new(drawit::DrawItRenderTool::new(vault_path.clone())));
    registry.register(Box::new(drawit::DrawItExportTool::new(vault_path.clone())));
    registry.register(Box::new(drawit::DrawItMapTool::new(vault_path.clone())));
    registry.register(Box::new(drawit::DrawItFlowTool::new(vault_path.clone())));
    registry.register(Box::new(drawit::DrawItAnalyzeTool::new(vault_path.clone())));
    registry.register(Box::new(drawit::CreateDiagramTool::new(vault_path.clone())));

    // Model benchmark tool (1)
    registry.register(Box::new(benchmark::BenchmarkModelTool::new(vault_path.clone())));

    // Browser automation tools
    for tool in browser::create_browser_tools() {
        registry.register(tool);
    }

    // Planning tools (11)
    for tool in planning::planning_tools(vault_path.clone(), db.clone()) {
        registry.register(tool);
    }

    // Webmail tools (6)
    for tool in webmail::webmail_tools() {
        registry.register(tool);
    }

    // Workflow engine tool (1)
    registry.register(Box::new(workflow::RunWorkflowTool::new(vault_path)));

    registry
}
