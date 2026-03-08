/**
 * Thin Ollama HTTP client.
 * Uses the local Ollama instance at http://localhost:11434
 * Default model: qwen3.5:9b (free, always available)
 */

const OLLAMA_BASE = process.env.OLLAMA_HOST ?? "http://localhost:11434";
export const MEMORY_MODEL = process.env.MEMORY_MODEL ?? "qwen3.5:9b";

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Chat with Ollama. Returns the assistant's response text.
 */
export async function ollamaChat(
  messages: OllamaChatMessage[],
  model = MEMORY_MODEL
): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: false }),
  });

  if (!res.ok) {
    throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as { message: { content: string } };
  return data.message.content.trim();
}

/**
 * Generate JSON from Ollama with retry on parse failure.
 */
export async function ollamaJSON<T>(
  systemPrompt: string,
  userPrompt: string,
  model = MEMORY_MODEL
): Promise<T> {
  const messages: OllamaChatMessage[] = [
    { role: "system", content: systemPrompt + "\n\nRespond ONLY with valid JSON. No markdown fences, no explanation." },
    { role: "user", content: userPrompt },
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = await ollamaChat(messages, model);
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/^```json?\n?/i, "").replace(/\n?```$/i, "").trim();
    try {
      return JSON.parse(cleaned) as T;
    } catch {
      // Retry with explicit correction message
      messages.push({ role: "assistant", content: raw });
      messages.push({ role: "user", content: "That was not valid JSON. Return ONLY the JSON object, nothing else." });
    }
  }
  throw new Error("Ollama failed to return valid JSON after 3 attempts");
}

/**
 * Check if Ollama is running and the model is available.
 */
export async function checkOllamaAvailable(model = MEMORY_MODEL): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    if (!res.ok) return false;
    const data = await res.json() as { models: Array<{ name: string }> };
    return data.models.some((m) => m.name.startsWith(model.split(":")[0]));
  } catch {
    return false;
  }
}
