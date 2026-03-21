use anyhow::{Context, Result};
use futures::StreamExt;
use hq_core::config::HqConfig;
use hq_core::types::{ChatMessage, MessageRole};
use hq_llm::openrouter::OpenRouterProvider;
use hq_llm::provider::{ChatRequest, LlmProvider, StreamChunk};
use hq_tools::skills::{SkillHintIndex, enrich_system_prompt};
use std::io::{self, BufRead, Write};

pub async fn run(config: &HqConfig, model_override: Option<String>) -> Result<()> {
    let api_key = config
        .openrouter_api_key
        .as_ref()
        .context("OpenRouter API key not set. Run `hq setup` or set HQ_OPENROUTER_API_KEY")?;

    let provider = OpenRouterProvider::new(api_key);
    let model = model_override.unwrap_or_else(|| config.default_model.clone());

    // Build skill hint index from vault skills directory
    let skills_dir = config.vault_path.join("skills");
    let skill_index = SkillHintIndex::build(&skills_dir);

    let base_prompt = "You are a helpful AI assistant. Be concise and direct.";

    println!("HQ Chat (model: {})", model);
    println!("Type your message. Press Ctrl+D to exit.");
    println!();

    let mut messages: Vec<ChatMessage> = vec![ChatMessage {
        role: MessageRole::System,
        content: base_prompt.to_string(),
        tool_calls: vec![],
        tool_call_id: None,
    }];

    let stdin = io::stdin();
    let mut stdout = io::stdout();

    loop {
        print!("you> ");
        stdout.flush()?;

        let mut input = String::new();
        if stdin.lock().read_line(&mut input)? == 0 {
            println!("\nGoodbye!");
            break;
        }

        let input = input.trim();
        if input.is_empty() {
            continue;
        }

        if input == "/quit" || input == "/exit" {
            println!("Goodbye!");
            break;
        }

        messages.push(ChatMessage {
            role: MessageRole::User,
            content: input.to_string(),
            tool_calls: vec![],
            tool_call_id: None,
        });

        // Re-enrich the system prompt based on this turn's user input
        messages[0].content = enrich_system_prompt(&skill_index, base_prompt, input);

        let request = ChatRequest {
            model: model.clone(),
            messages: messages.clone(),
            tools: vec![],
            temperature: Some(0.7),
            max_tokens: Some(4096),
        };

        print!("hq> ");
        stdout.flush()?;

        let mut stream = provider.chat_stream(&request).await?;
        let mut full_response = String::new();

        while let Some(chunk) = stream.next().await {
            match chunk? {
                StreamChunk::Text(text) => {
                    print!("{}", text);
                    stdout.flush()?;
                    full_response.push_str(&text);
                }
                StreamChunk::Done => break,
                StreamChunk::Usage { input_tokens: _, output_tokens: _ } => {
                    // Could display token counts if verbose
                }
                _ => {}
            }
        }

        println!();
        println!();

        messages.push(ChatMessage {
            role: MessageRole::Assistant,
            content: full_response,
            tool_calls: vec![],
            tool_call_id: None,
        });

        // Simple context window management: keep last 50 messages + system
        if messages.len() > 51 {
            let system = messages[0].clone();
            let skip = messages.len() - 50;
            let tail: Vec<_> = messages.drain(1..).skip(skip).collect();
            messages = vec![system];
            messages.extend(tail);
        }
    }

    Ok(())
}
