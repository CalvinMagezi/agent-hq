/**
 * generate_image — HQ Tool
 *
 * Generates images via OpenRouter using the cheapest available model.
 * Saves output to vault/_jobs/outputs/ and returns a markdown embed.
 * Auto-falls back through model list on transient errors (404, 503, rate-limit).
 *
 * Model priority (cheapest first):
 *   1. google/gemini-2.5-flash-image          (token-based, very cheap)
 *   2. google/gemini-3.1-flash-image-preview   (next-gen, cheap)
 *   3. openai/gpt-5-image-mini                 (reliable fallback)
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

const MODELS_CHEAPEST_FIRST = [
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-image-preview",
  "openai/gpt-5-image-mini",
];

interface ImageGenInput {
  prompt: string;
  width?: number;
  height?: number;
  model?: string;
}


export const ImageGenTool: HQTool<ImageGenInput, string> = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt using AI models via OpenRouter. The image is saved to the vault and a markdown embed is returned. Defaults to the cheapest available model.",
  tags: ["image", "generation", "creative", "ai", "visual", "draw", "picture", "art"],
  schema: Type.Object({
    prompt: Type.String({ description: "Text description of the image to generate" }),
    width: Type.Optional(Type.Number({ description: "Image width in pixels (optional hint)" })),
    height: Type.Optional(Type.Number({ description: "Image height in pixels (optional hint)" })),
    model: Type.Optional(
      Type.String({
        description: `Model override. Defaults to cheapest: ${MODELS_CHEAPEST_FIRST[0]}`,
      })
    ),
  }),

  async execute(input: ImageGenInput, ctx: HQContext): Promise<string> {
    const apiKey = ctx.openrouterApiKey;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not configured — cannot generate images");
    }

    let promptText = input.prompt;
    if (input.width && input.height) {
      promptText += `\n\nDesired resolution: ${input.width}x${input.height}`;
    }

    // If user specified a model, try only that one. Otherwise try the fallback chain.
    const modelsToTry = input.model
      ? [input.model]
      : MODELS_CHEAPEST_FIRST;

    let lastError = "";
    for (const modelId of modelsToTry) {
      try {
        const result = await callOpenRouter(apiKey, modelId, promptText);
        const output = await saveImage(result.imageUrl, modelId, ctx);
        // Return a [FILE:] marker so relay bots (Discord, WhatsApp) auto-send the image as an attachment
        const displayName = path.basename(output.filePath);
        return `Image generated (${output.model}):\n[FILE: ${output.filePath} | ${displayName}]`;
      } catch (err: any) {
        lastError = err.message ?? String(err);
        // Only fall back on transient/model errors (404, 503, 429, timeout)
        const isTransient =
          lastError.includes("404") ||
          lastError.includes("503") ||
          lastError.includes("429") ||
          lastError.includes("rate") ||
          lastError.includes("timeout") ||
          lastError.includes("No endpoints");
        if (!isTransient || input.model) {
          throw err; // Don't fallback on auth errors or user-specified model
        }
        console.warn(`[imageGen] ${modelId} failed (${lastError.slice(0, 100)}), trying next model...`);
      }
    }

    throw new Error(`All image models failed. Last error: ${lastError}`);
  },
};

/** Call OpenRouter and return the raw image data URL */
async function callOpenRouter(
  apiKey: string,
  modelId: string,
  promptText: string
): Promise<{ imageUrl: string }> {
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/CalvinMagezi/agent-hq",
      "X-Title": "Agent-HQ",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "user", content: promptText }],
      modalities: ["image", "text"],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText);
    throw new Error(`OpenRouter ${response.status}: ${err}`);
  }

  const data: any = await response.json();
  const images = data?.choices?.[0]?.message?.images;
  if (!images?.length) {
    throw new Error(
      `No images returned from ${modelId}. Response: ${JSON.stringify(data).slice(0, 500)}`
    );
  }

  const imageEntry = images[0];
  const imageUrl: string =
    imageEntry?.image_url?.url ?? imageEntry?.url ?? imageEntry ?? "";
  if (!imageUrl) {
    throw new Error("Could not extract image URL from OpenRouter response");
  }

  return { imageUrl };
}

/** Decode image bytes and save to vault */
async function saveImage(
  imageUrl: string,
  modelId: string,
  ctx: HQContext
): Promise<{ filePath: string; model: string; mimeType: string }> {
  let bytes: Uint8Array;
  let mimeType = "image/png";

  if (imageUrl.startsWith("data:")) {
    const commaIdx = imageUrl.indexOf(",");
    const header = imageUrl.slice(0, commaIdx);
    const base64 = imageUrl.slice(commaIdx + 1);
    mimeType = header.split(":")[1]?.split(";")[0] ?? "image/png";
    bytes = new Uint8Array(Buffer.from(base64, "base64"));
  } else {
    const imgResp = await fetch(imageUrl, {
      signal: AbortSignal.timeout(60_000),
    });
    mimeType = imgResp.headers.get("content-type") ?? "image/png";
    bytes = new Uint8Array(await imgResp.arrayBuffer());
  }

  const ext = mimeType.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const hash = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const filename = `img-${Date.now()}-${hash}.${ext}`;
  const outputDir = path.join(ctx.vaultPath, "_jobs", "outputs");
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  fs.writeFileSync(filePath, bytes);

  return { filePath, model: modelId, mimeType };
}
