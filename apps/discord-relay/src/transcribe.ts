import { spawn } from "bun";
import { unlink } from "fs/promises";
import type { RelayConfig } from "./types.js";

export interface TranscriptionResult {
  text: string;
  durationSecs?: number;
  provider: "groq" | "whisper";
}

export interface Transcriber {
  transcribe(audioPath: string): Promise<TranscriptionResult>;
}

// ── Groq Cloud Transcriber ─────────────────────────────────────────────

class GroqTranscriber implements Transcriber {
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    const file = Bun.file(audioPath);
    const formData = new FormData();
    formData.append("file", file);
    formData.append("model", "whisper-large-v3-turbo");
    formData.append("response_format", "verbose_json");

    const response = await fetch(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq transcription failed (${response.status}): ${errText}`);
    }

    const data = (await response.json()) as { text?: string; duration?: number };

    return {
      text: (data.text || "").trim(),
      durationSecs: data.duration,
      provider: "groq",
    };
  }
}

// ── Local whisper.cpp Transcriber ──────────────────────────────────────

class WhisperTranscriber implements Transcriber {
  private whisperPath: string;
  private modelPath: string;

  constructor(whisperPath: string, modelPath: string) {
    this.whisperPath = whisperPath;
    this.modelPath = modelPath;
  }

  async transcribe(audioPath: string): Promise<TranscriptionResult> {
    // whisper.cpp requires WAV 16kHz mono — convert from OGG via ffmpeg
    const wavPath = audioPath.replace(/\.[^.]+$/, ".wav");

    try {
      // Convert OGG → WAV
      const ffmpeg = spawn(
        ["ffmpeg", "-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "wav", wavPath],
        { stdout: "pipe", stderr: "pipe" },
      );
      const ffmpegExit = await ffmpeg.exited;
      if (ffmpegExit !== 0) {
        const stderr = await new Response(ffmpeg.stderr).text();
        throw new Error(`ffmpeg conversion failed: ${stderr.substring(0, 200)}`);
      }

      // Run whisper.cpp
      const proc = spawn(
        [this.whisperPath, "-m", this.modelPath, "-f", wavPath, "--no-timestamps", "-otxt"],
        { stdout: "pipe", stderr: "pipe" },
      );
      const whisperExit = await proc.exited;
      if (whisperExit !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`whisper.cpp failed: ${stderr.substring(0, 200)}`);
      }

      // whisper.cpp with -otxt writes output to <input>.txt
      const txtPath = wavPath + ".txt";
      let text: string;
      try {
        text = await Bun.file(txtPath).text();
        await unlink(txtPath).catch(() => {});
      } catch {
        // Fallback: read from stdout
        text = await new Response(proc.stdout).text();
      }

      return {
        text: text.trim(),
        provider: "whisper",
      };
    } finally {
      await unlink(wavPath).catch(() => {});
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────

export function createTranscriber(config: RelayConfig): Transcriber | null {
  const provider = config.voiceProvider;

  if (provider === "groq") {
    if (!config.groqApiKey) {
      console.warn("[Voice] GROQ_API_KEY not set — voice transcription disabled");
      return null;
    }
    console.log("[Voice] Using Groq cloud transcription (whisper-large-v3-turbo)");
    return new GroqTranscriber(config.groqApiKey);
  }

  if (provider === "whisper") {
    if (!config.whisperPath || !config.whisperModel) {
      console.warn("[Voice] WHISPER_PATH or WHISPER_MODEL not set — voice transcription disabled");
      return null;
    }
    console.log(`[Voice] Using local whisper.cpp: ${config.whisperPath}`);
    return new WhisperTranscriber(config.whisperPath, config.whisperModel);
  }

  // provider === "none" or unset
  return null;
}
