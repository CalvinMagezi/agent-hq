use anyhow::{Context, Result};
use async_trait::async_trait;
use async_openai::{
    Client,
    config::OpenAIConfig,
    types::{
        ChatCompletionRequestMessage, ChatCompletionRequestSystemMessage,
        ChatCompletionRequestUserMessage, ChatCompletionRequestAssistantMessage,
        ChatCompletionRequestToolMessage,
        ChatCompletionTool, ChatCompletionToolType, FunctionObject,
        CreateChatCompletionRequest,
    },
};
use futures::StreamExt;
use hq_core::types::{ChatMessage, MessageRole, ToolCall};
use std::pin::Pin;
use tokio_stream::Stream;

use crate::provider::{ChatRequest, ChatResponse, LlmProvider, StreamChunk};

/// OpenRouter provider (uses OpenAI-compatible API).
pub struct OpenRouterProvider {
    client: Client<OpenAIConfig>,
}

impl OpenRouterProvider {
    pub fn new(api_key: &str) -> Self {
        let config = OpenAIConfig::new()
            .with_api_key(api_key)
            .with_api_base("https://openrouter.ai/api/v1");

        let client = Client::with_config(config);
        Self { client }
    }
}

#[async_trait]
impl LlmProvider for OpenRouterProvider {
    fn name(&self) -> &str {
        "openrouter"
    }

    async fn chat(&self, request: &ChatRequest) -> Result<ChatResponse> {
        let oai_request = build_request(request)?;
        let response = self
            .client
            .chat()
            .create(oai_request)
            .await
            .context("OpenRouter chat completion")?;

        let choice = response
            .choices
            .first()
            .context("no choices in response")?;

        let message = parse_assistant_message(choice)?;

        let (input_tokens, output_tokens) = match response.usage {
            Some(usage) => (usage.prompt_tokens, usage.completion_tokens),
            None => (0, 0),
        };

        Ok(ChatResponse {
            message,
            input_tokens,
            output_tokens,
            model: response.model,
        })
    }

    async fn chat_stream(
        &self,
        request: &ChatRequest,
    ) -> Result<Pin<Box<dyn Stream<Item = Result<StreamChunk>> + Send>>> {
        let mut oai_request = build_request(request)?;
        oai_request.stream = Some(true);

        let stream = self
            .client
            .chat()
            .create_stream(oai_request)
            .await
            .context("OpenRouter chat stream")?;

        let mapped = stream.map(|result| {
            match result {
                Ok(response) => {
                    let choice = match response.choices.first() {
                        Some(c) => c,
                        None => return Ok(StreamChunk::Done),
                    };

                    let delta = &choice.delta;

                    // Check for tool call deltas
                    if let Some(ref tool_calls) = delta.tool_calls {
                        for tc in tool_calls {
                            if let Some(ref func) = tc.function {
                                return Ok(StreamChunk::ToolCallDelta {
                                    index: tc.index as usize,
                                    id: tc.id.clone(),
                                    name: func.name.clone(),
                                    arguments_delta: func.arguments.clone().unwrap_or_default(),
                                });
                            }
                        }
                    }

                    // Text content
                    if let Some(ref content) = delta.content {
                        if !content.is_empty() {
                            return Ok(StreamChunk::Text(content.clone()));
                        }
                    }

                    // Check for finish
                    if choice.finish_reason.is_some() {
                        return Ok(StreamChunk::Done);
                    }

                    Ok(StreamChunk::Text(String::new()))
                }
                Err(e) => Err(anyhow::anyhow!("stream error: {}", e)),
            }
        });

        Ok(Box::pin(mapped))
    }
}

fn build_request(req: &ChatRequest) -> Result<CreateChatCompletionRequest> {
    let messages: Vec<ChatCompletionRequestMessage> = req
        .messages
        .iter()
        .map(|m| match m.role {
            MessageRole::System => ChatCompletionRequestMessage::System(
                ChatCompletionRequestSystemMessage {
                    content: async_openai::types::ChatCompletionRequestSystemMessageContent::Text(m.content.clone()),
                    name: None,
                },
            ),
            MessageRole::User => ChatCompletionRequestMessage::User(
                ChatCompletionRequestUserMessage {
                    content: async_openai::types::ChatCompletionRequestUserMessageContent::Text(m.content.clone()),
                    name: None,
                },
            ),
            MessageRole::Assistant => ChatCompletionRequestMessage::Assistant(
                ChatCompletionRequestAssistantMessage {
                    content: Some(async_openai::types::ChatCompletionRequestAssistantMessageContent::Text(m.content.clone())),
                    name: None,
                    tool_calls: if m.tool_calls.is_empty() {
                        None
                    } else {
                        Some(
                            m.tool_calls
                                .iter()
                                .map(|tc| async_openai::types::ChatCompletionMessageToolCall {
                                    id: tc.id.clone(),
                                    r#type: ChatCompletionToolType::Function,
                                    function: async_openai::types::FunctionCall {
                                        name: tc.name.clone(),
                                        arguments: tc.arguments.to_string(),
                                    },
                                })
                                .collect(),
                        )
                    },
                    ..Default::default()
                },
            ),
            MessageRole::Tool => ChatCompletionRequestMessage::Tool(
                ChatCompletionRequestToolMessage {
                    content: async_openai::types::ChatCompletionRequestToolMessageContent::Text(m.content.clone()),
                    tool_call_id: m.tool_call_id.clone().unwrap_or_default(),
                },
            ),
        })
        .collect();

    let tools: Option<Vec<ChatCompletionTool>> = if req.tools.is_empty() {
        None
    } else {
        Some(
            req.tools
                .iter()
                .map(|t| ChatCompletionTool {
                    r#type: ChatCompletionToolType::Function,
                    function: FunctionObject {
                        name: t.name.clone(),
                        description: Some(t.description.clone()),
                        parameters: Some(t.parameters.clone()),
                        strict: None,
                    },
                })
                .collect(),
        )
    };

    Ok(CreateChatCompletionRequest {
        model: req.model.clone(),
        messages,
        tools,
        temperature: req.temperature,
        max_completion_tokens: req.max_tokens,
        stream: Some(false),
        ..Default::default()
    })
}

fn parse_assistant_message(
    choice: &async_openai::types::ChatChoice,
) -> Result<ChatMessage> {
    let msg = &choice.message;

    let tool_calls: Vec<ToolCall> = msg
        .tool_calls
        .as_ref()
        .map(|tcs| {
            tcs.iter()
                .map(|tc| ToolCall {
                    id: tc.id.clone(),
                    name: tc.function.name.clone(),
                    arguments: serde_json::from_str(&tc.function.arguments)
                        .unwrap_or(serde_json::Value::String(tc.function.arguments.clone())),
                })
                .collect()
        })
        .unwrap_or_default();

    Ok(ChatMessage {
        role: MessageRole::Assistant,
        content: msg.content.clone().unwrap_or_default(),
        tool_calls,
        tool_call_id: None,
    })
}
