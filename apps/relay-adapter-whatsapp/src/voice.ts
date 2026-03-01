/**
 * VoiceHandler — Transcription and TTS for WhatsApp voice notes.
 *
 * Transcription: Groq API (whisper-large-v3-turbo) — same service as Discord relay.
 *   Requires: GROQ_API_KEY
 *
 * TTS (voice replies, optional): OpenAI /v1/audio/speech → OGG Opus.
 *   Requires: OPENAI_API_KEY
 *
 * Both use the OpenAI-compatible API format. Transcription and TTS are
 * configured independently so you can have transcription without TTS.
 */

export interface VoiceHandlerConfig {
  /** Groq API key for transcription (whisper-large-v3-turbo). */
  transcriptionApiKey: string;
  /** Transcription API base. Defaults to Groq. */
  transcriptionApiBase?: string;
  /** Whisper model. Defaults to "whisper-large-v3-turbo" (Groq). */
  transcriptionModel?: string;
  /** OpenAI API key for TTS. Optional — voice replies disabled if not set. */
  ttsApiKey?: string;
  /** TTS API base. Defaults to OpenAI. */
  ttsApiBase?: string;
  /** TTS model. Defaults to "tts-1". */
  ttsModel?: string;
  /** TTS voice. Defaults to "alloy". Options: alloy, echo, fable, onyx, nova, shimmer. */
  ttsVoice?: string;
}

export class VoiceHandler {
  private transcriptionApiKey: string;
  private transcriptionApiBase: string;
  private transcriptionModel: string;
  private ttsApiKey: string | null;
  private ttsApiBase: string;
  private ttsModel: string;
  private ttsVoice: string;

  constructor(config: VoiceHandlerConfig) {
    this.transcriptionApiKey = config.transcriptionApiKey;
    this.transcriptionApiBase = (
      config.transcriptionApiBase ?? "https://api.groq.com/openai"
    ).replace(/\/$/, "");
    this.transcriptionModel = config.transcriptionModel ?? "whisper-large-v3-turbo";
    this.ttsApiKey = config.ttsApiKey ?? null;
    this.ttsApiBase = (config.ttsApiBase ?? "https://api.openai.com").replace(/\/$/, "");
    this.ttsModel = config.ttsModel ?? "tts-1";
    this.ttsVoice = config.ttsVoice ?? "alloy";
  }

  /** Whether voice replies (TTS) are available. */
  get canSynthesize(): boolean {
    return !!this.ttsApiKey;
  }

  /**
   * Transcribe audio buffer using Groq Whisper.
   * @param audioBuffer - Raw audio data (OGG Opus, MP3, etc.)
   * @param filename - Filename with extension for MIME type detection
   */
  async transcribe(audioBuffer: Buffer, filename = "audio.ogg"): Promise<string> {
    const formData = new FormData();
    const blob = new Blob([audioBuffer], { type: this.getMimeType(filename) });
    formData.append("file", blob, filename);
    formData.append("model", this.transcriptionModel);
    formData.append("response_format", "verbose_json");

    const response = await fetch(
      `${this.transcriptionApiBase}/v1/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.transcriptionApiKey}`,
        },
        body: formData,
      },
    );

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq transcription failed (${response.status}): ${err}`);
    }

    const json = (await response.json()) as { text?: string; duration?: number };
    return (json.text ?? "").trim();
  }

  /**
   * Synthesize text to OGG Opus audio (WhatsApp voice note format).
   * Returns a Buffer ready to send via Baileys with ptt: true.
   * Throws if OPENAI_API_KEY is not configured.
   */
  async synthesize(text: string): Promise<Buffer> {
    if (!this.ttsApiKey) {
      throw new Error("TTS not configured — set OPENAI_API_KEY to enable voice replies");
    }

    const response = await fetch(`${this.ttsApiBase}/v1/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.ttsApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.ttsModel,
        input: text,
        voice: this.ttsVoice,
        response_format: "opus",
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`TTS API error ${response.status}: ${err}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  private getMimeType(filename: string): string {
    const ext = filename.split(".").pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      ogg: "audio/ogg",
      mp3: "audio/mpeg",
      mp4: "audio/mp4",
      m4a: "audio/m4a",
      wav: "audio/wav",
      webm: "audio/webm",
      aac: "audio/aac",
    };
    return mimeTypes[ext ?? ""] ?? "audio/ogg";
  }
}
