/**
 * speak — HQ Tool
 *
 * Text-to-speech via local models. Three-tier architecture:
 *   Tier 1 (default):  Kokoro-82M via kokoro-onnx (pip install kokoro-onnx soundfile)
 *                      ~600 MB RAM, ~0.3s/sentence, ONNX CPU inference
 *                      Model files: ~/.agent-hq/voice/kokoro-v1.0.int8.onnx
 *                                   ~/.agent-hq/voice/voices-v1.0.bin
 *   Tier 2 (clone):    F5-TTS MLX (pip install f5-tts-mlx)
 *                      Zero-shot voice cloning from _system/voice/reference.wav
 *   Tier 3 (fallback): macOS `say` command — 15ms, zero dependencies
 *
 * One-time setup:
 *   pip3.13 install kokoro-onnx soundfile
 *   # Model files live in ~/.agent-hq/voice/ (outside vault to avoid iCloud sync issues)
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { spawnSync } from "child_process";
import { Type } from "@sinclair/typebox";
import type { HQTool, HQContext } from "../registry.js";

// Cached availability checks (per process)
let _kokoroAvailable: boolean | null = null;
let _f5Available: boolean | null = null;

function checkPython(module: string): boolean {
  const result = spawnSync("python3.13", ["-c", `import ${module}`], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return result.status === 0;
}

function isKokoroAvailable(): boolean {
  if (_kokoroAvailable !== null) return _kokoroAvailable;
  _kokoroAvailable = checkPython("kokoro_onnx") && checkPython("soundfile");
  return _kokoroAvailable;
}

function isF5Available(): boolean {
  if (_f5Available !== null) return _f5Available;
  _f5Available =
    spawnSync("f5-tts-mlx", ["--help"], { encoding: "utf-8", timeout: 5000 }).status === 0 ||
    checkPython("f5_tts_mlx");
  return _f5Available;
}

interface TTSInput {
  text: string;
  voice?: string;
  speed?: number;
  clone?: boolean;
  save?: string;
  play?: boolean;
}

const KOKORO_SCRIPT = `
import sys, os
import kokoro_onnx
import soundfile as sf

text    = sys.argv[1]
voice   = sys.argv[2] if len(sys.argv) > 2 else "af_heart"
speed   = float(sys.argv[3]) if len(sys.argv) > 3 else 1.0
out     = sys.argv[4] if len(sys.argv) > 4 else "/tmp/hq-speech.wav"
model   = sys.argv[5]
voices  = sys.argv[6]

kokoro = kokoro_onnx.Kokoro(model, voices)
samples, rate = kokoro.create(text, voice=voice, speed=speed, lang="en-us")
sf.write(out, samples, rate)
print(out)
`;

/** Resolve Kokoro model directory — prefers ~/.agent-hq/voice/, falls back to vault */
function resolveModelDir(vaultPath: string): string {
  const preferredDir = path.join(os.homedir(), ".agent-hq", "voice");
  const preferredModel = path.join(preferredDir, "kokoro-v1.0.int8.onnx");
  if (fs.existsSync(preferredModel)) return preferredDir;
  return path.join(vaultPath, "_system", "voice");
}

async function speakKokoro(
  text: string,
  voice: string,
  speed: number,
  outputPath: string,
  vaultPath: string
): Promise<boolean> {
  const modelDir   = resolveModelDir(vaultPath);
  const modelPath  = path.join(modelDir, "kokoro-v1.0.int8.onnx");
  const voicesPath = path.join(modelDir, "voices-v1.0.bin");

  if (!fs.existsSync(modelPath) || !fs.existsSync(voicesPath)) {
    console.warn(
      `[TTS/kokoro] Model files missing. Expected at ~/.agent-hq/voice/ or ${vaultPath}/_system/voice/. ` +
        "Run: mkdir -p ~/.agent-hq/voice && cp kokoro-v1.0.int8.onnx voices-v1.0.bin ~/.agent-hq/voice/"
    );
    return false;
  }

  const scriptFile = path.join(os.tmpdir(), "hq-kokoro.py");
  fs.writeFileSync(scriptFile, KOKORO_SCRIPT);

  const result = spawnSync(
    "python3.13",
    [scriptFile, text, voice, String(speed), outputPath, modelPath, voicesPath],
    { encoding: "utf-8", timeout: 30_000 }
  );

  if (result.status !== 0) {
    console.warn("[TTS/kokoro] error:", result.stderr?.slice(0, 300));
    return false;
  }
  return true;
}

async function speakF5(
  text: string,
  vaultPath: string,
  outputPath: string
): Promise<boolean> {
  const refAudio = path.join(vaultPath, "_system", "voice", "reference.wav");
  const refTranscriptPath = path.join(vaultPath, "_system", "voice", "reference-transcript.txt");

  if (!fs.existsSync(refAudio)) {
    console.warn("[TTS/f5] No reference audio at _system/voice/reference.wav");
    return false;
  }

  const refText = fs.existsSync(refTranscriptPath)
    ? fs.readFileSync(refTranscriptPath, "utf-8").trim()
    : "This is a reference audio clip.";

  const result = spawnSync(
    "f5-tts-mlx",
    ["--text", text, "--ref-audio", refAudio, "--ref-text", refText, "--output", outputPath],
    { encoding: "utf-8", timeout: 60_000 }
  );

  if (result.status !== 0) {
    console.warn("[TTS/f5] error:", result.stderr?.slice(0, 300));
    return false;
  }
  return true;
}

function speakSay(text: string): void {
  for (const v of ["Ava", "Zoe", "Samantha"]) {
    const r = spawnSync("say", ["-v", v, text], { timeout: 30_000 });
    if (r.status === 0) return;
  }
  spawnSync("say", [text], { timeout: 30_000 });
}

function playAudio(filePath: string): void {
  spawnSync("afplay", [filePath], { timeout: 60_000 });
}

export const SpeakTool: HQTool<TTSInput, string> = {
  name: "speak",
  description:
    "Generate speech audio from text using Kokoro-82M (local, free, high quality). By default only returns a [FILE:] marker so relay channels (Telegram, Discord) can send it as a voice note — the laptop speakers are NOT used unless play:true is explicitly set. Use play:true only when the user is known to be at their machine.",
  tags: ["tts", "speech", "voice", "audio", "speak", "read", "aloud", "notification", "sound"],
  schema: Type.Object({
    text: Type.String({ description: "Text to convert to speech" }),
    voice: Type.Optional(
      Type.String({
        description:
          "Kokoro voice ID. Options: af_heart (warm female, default), af_nova (clear female), am_echo (deep male), am_onyx (authoritative male), bf_emma (British female), bm_george (British male)",
      })
    ),
    speed: Type.Optional(
      Type.Number({ description: "Speech speed multiplier. Range 0.5–2.0, default 1.0" })
    ),
    clone: Type.Optional(
      Type.Boolean({
        description:
          "If true, use F5-TTS to speak in the user's own cloned voice. Requires _system/voice/reference.wav in the vault.",
      })
    ),
    play: Type.Optional(
      Type.Boolean({
        description:
          "If true, also play the audio on the laptop speakers via afplay. Default false — omit this unless the user is confirmed to be at their machine, to avoid playing audio unexpectedly.",
      })
    ),
    save: Type.Optional(
      Type.String({ description: "Optional file path to save the generated WAV audio" })
    ),
  }),

  async execute(input: TTSInput, ctx: HQContext): Promise<string> {
    const { text, voice = "af_heart", speed = 1.0, clone = false, play = false, save } = input;
    const outputPath = save ?? path.join(os.tmpdir(), `hq-speech-${Date.now()}.wav`);

    // Tier 2: Voice cloning via F5-TTS
    if (clone) {
      if (isF5Available()) {
        const ok = await speakF5(text, ctx.vaultPath, outputPath);
        if (ok) {
          if (play) playAudio(outputPath);
          return `Generated speech (F5-TTS cloned voice)\n[FILE: ${outputPath} | voice-clone.wav]`;
        }
      } else {
        console.warn("[TTS] f5-tts-mlx not installed. Run: pip install f5-tts-mlx");
      }
    }

    // Tier 1: Kokoro-82M via kokoro-onnx
    if (isKokoroAvailable()) {
      const ok = await speakKokoro(text, voice, speed, outputPath, ctx.vaultPath);
      if (ok) {
        if (play) playAudio(outputPath);
        const displayName = `voice-${voice}.wav`;
        return `Generated speech (Kokoro-82M, voice: ${voice})\n[FILE: ${outputPath} | ${displayName}]`;
      }
    } else {
      console.warn(
        "[TTS] kokoro-onnx not installed. Run: pip3.13 install kokoro-onnx soundfile"
      );
    }

    // Tier 3: macOS say — only if play explicitly requested, otherwise silent failure
    if (play) {
      speakSay(text);
      return "Spoke via macOS say (install kokoro-onnx for voice note support: pip3.13 install kokoro-onnx soundfile)";
    }
    return "TTS unavailable — install kokoro-onnx: pip3.13 install kokoro-onnx soundfile";
  },
};
