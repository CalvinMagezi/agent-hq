//! Text-to-speech tool — three-tier TTS architecture.
//!
//! Port of the TypeScript `speak` tool.
//! - Tier 1: Kokoro-82M via python3.13 + kokoro-onnx
//! - Tier 2: F5-TTS MLX for voice cloning
//! - Tier 3: macOS `say` fallback

use anyhow::Result;
use async_trait::async_trait;
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::process::Command;

use crate::registry::HqTool;

static KOKORO_CHECKED: AtomicBool = AtomicBool::new(false);
static KOKORO_AVAILABLE: AtomicBool = AtomicBool::new(false);
static F5_CHECKED: AtomicBool = AtomicBool::new(false);
static F5_AVAILABLE: AtomicBool = AtomicBool::new(false);

async fn check_python_module(module: &str) -> bool {
    Command::new("python3.13")
        .args(["-c", &format!("import {module}")])
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
}

async fn is_kokoro_available() -> bool {
    if KOKORO_CHECKED.load(Ordering::Relaxed) {
        return KOKORO_AVAILABLE.load(Ordering::Relaxed);
    }
    let avail = check_python_module("kokoro_onnx").await && check_python_module("soundfile").await;
    KOKORO_AVAILABLE.store(avail, Ordering::Relaxed);
    KOKORO_CHECKED.store(true, Ordering::Relaxed);
    avail
}

async fn is_f5_available() -> bool {
    if F5_CHECKED.load(Ordering::Relaxed) {
        return F5_AVAILABLE.load(Ordering::Relaxed);
    }
    let avail = Command::new("f5-tts-mlx")
        .arg("--help")
        .output()
        .await
        .map(|o| o.status.success())
        .unwrap_or(false)
        || check_python_module("f5_tts_mlx").await;
    F5_AVAILABLE.store(avail, Ordering::Relaxed);
    F5_CHECKED.store(true, Ordering::Relaxed);
    avail
}

fn resolve_model_dir(vault_path: &std::path::Path) -> PathBuf {
    let home = dirs::home_dir().unwrap_or_default();
    let preferred = home.join(".agent-hq").join("voice");
    if preferred.join("kokoro-v1.0.int8.onnx").exists() {
        preferred
    } else {
        vault_path.join("_system").join("voice")
    }
}

const KOKORO_SCRIPT: &str = r#"
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
"#;

/// Text-to-speech via local models.
pub struct SpeakTool {
    vault_path: PathBuf,
}

impl SpeakTool {
    pub fn new(vault_path: PathBuf) -> Self {
        Self { vault_path }
    }

    async fn speak_kokoro(
        &self,
        text: &str,
        voice: &str,
        speed: f64,
        output_path: &str,
    ) -> Result<bool> {
        let model_dir = resolve_model_dir(&self.vault_path);
        let model_path = model_dir.join("kokoro-v1.0.int8.onnx");
        let voices_path = model_dir.join("voices-v1.0.bin");

        if !model_path.exists() || !voices_path.exists() {
            tracing::warn!("[TTS/kokoro] Model files missing at {}", model_dir.display());
            return Ok(false);
        }

        let script_file = std::env::temp_dir().join("hq-kokoro.py");
        tokio::fs::write(&script_file, KOKORO_SCRIPT).await?;

        let output = Command::new("python3.13")
            .args([
                script_file.to_str().unwrap_or_default(),
                text,
                voice,
                &speed.to_string(),
                output_path,
                model_path.to_str().unwrap_or_default(),
                voices_path.to_str().unwrap_or_default(),
            ])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!("[TTS/kokoro] error: {}", &stderr[..stderr.len().min(300)]);
            return Ok(false);
        }
        Ok(true)
    }

    async fn speak_f5(&self, text: &str, output_path: &str) -> Result<bool> {
        let ref_audio = self.vault_path.join("_system/voice/reference.wav");
        let ref_transcript = self.vault_path.join("_system/voice/reference-transcript.txt");

        if !ref_audio.exists() {
            tracing::warn!("[TTS/f5] No reference audio at _system/voice/reference.wav");
            return Ok(false);
        }

        let ref_text = if ref_transcript.exists() {
            tokio::fs::read_to_string(&ref_transcript)
                .await
                .unwrap_or_else(|_| "This is a reference audio clip.".to_string())
                .trim()
                .to_string()
        } else {
            "This is a reference audio clip.".to_string()
        };

        let output = Command::new("f5-tts-mlx")
            .args([
                "--text",
                text,
                "--ref-audio",
                ref_audio.to_str().unwrap_or_default(),
                "--ref-text",
                &ref_text,
                "--output",
                output_path,
            ])
            .output()
            .await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            tracing::warn!("[TTS/f5] error: {}", &stderr[..stderr.len().min(300)]);
            return Ok(false);
        }
        Ok(true)
    }

    async fn speak_say(text: &str) {
        for voice in &["Ava", "Zoe", "Samantha"] {
            if let Ok(o) = Command::new("say").args(["-v", voice, text]).output().await {
                if o.status.success() {
                    return;
                }
            }
        }
        let _ = Command::new("say").arg(text).output().await;
    }

    async fn play_audio(path: &str) {
        let _ = Command::new("afplay").arg(path).output().await;
    }
}

#[async_trait]
impl HqTool for SpeakTool {
    fn name(&self) -> &str {
        "speak"
    }

    fn description(&self) -> &str {
        "Generate speech audio from text using Kokoro-82M (local, free, high quality). Returns a [FILE:] marker for relay channels."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "text": { "type": "string", "description": "Text to convert to speech" },
                "voice": {
                    "type": "string",
                    "description": "Kokoro voice ID: af_heart (warm female, default), af_nova, am_echo, am_onyx, bf_emma, bm_george"
                },
                "speed": { "type": "number", "description": "Speech speed 0.5-2.0 (default 1.0)" },
                "clone": { "type": "boolean", "description": "Use F5-TTS voice cloning from reference.wav" },
                "play": { "type": "boolean", "description": "Play audio on laptop speakers via afplay (default false)" },
                "save": { "type": "string", "description": "Optional file path to save the WAV" }
            },
            "required": ["text"]
        })
    }

    fn category(&self) -> &str {
        "creative"
    }

    async fn execute(&self, args: Value) -> Result<Value> {
        let text = args
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let voice = args
            .get("voice")
            .and_then(|v| v.as_str())
            .unwrap_or("af_heart");
        let speed = args.get("speed").and_then(|v| v.as_f64()).unwrap_or(1.0);
        let clone = args.get("clone").and_then(|v| v.as_bool()).unwrap_or(false);
        let play = args.get("play").and_then(|v| v.as_bool()).unwrap_or(false);
        let save = args.get("save").and_then(|v| v.as_str());

        let now = chrono::Utc::now().timestamp_millis();
        let output_path = save
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                std::env::temp_dir()
                    .join(format!("hq-speech-{now}.wav"))
                    .to_string_lossy()
                    .to_string()
            });

        // Tier 2: Voice cloning
        if clone && is_f5_available().await {
            if self.speak_f5(text, &output_path).await? {
                if play {
                    Self::play_audio(&output_path).await;
                }
                return Ok(json!({
                    "message": format!(
                        "Generated speech (F5-TTS cloned voice)\n[FILE: {output_path} | voice-clone.wav]"
                    ),
                    "filePath": output_path,
                }));
            }
        }

        // Tier 1: Kokoro-82M
        if is_kokoro_available().await {
            if self.speak_kokoro(text, voice, speed, &output_path).await? {
                if play {
                    Self::play_audio(&output_path).await;
                }
                return Ok(json!({
                    "message": format!(
                        "Generated speech (Kokoro-82M, voice: {voice})\n[FILE: {output_path} | voice-{voice}.wav]"
                    ),
                    "filePath": output_path,
                }));
            }
        }

        // Tier 3: macOS say
        if play {
            Self::speak_say(text).await;
            return Ok(json!({
                "message": "Spoke via macOS say (install kokoro-onnx for voice note support)"
            }));
        }

        Ok(json!({
            "message": "TTS unavailable — install kokoro-onnx: pip3.13 install kokoro-onnx soundfile"
        }))
    }
}
