---
name: voice
description: "Text-to-speech via Kokoro-82M (local, free, high quality). Generates a voice note and sends it over the active communication channel (Telegram, Discord). Auto-loaded for all agents."
---

# Voice Skill

You can generate speech audio using the `speak` HQ tool. The audio is sent as a voice note over whatever channel the user is on (Telegram, Discord, etc.).

## IMPORTANT: Default behaviour

**Do NOT play audio on the laptop speakers unless the user is explicitly at their machine.**
The `play` parameter defaults to `false`. This prevents audio playing unexpectedly from the laptop when the user is away (on their phone, in a meeting, etc.).

| Situation | Correct call |
|-----------|-------------|
| User is on Telegram / phone / away | `"play": false` (default — omit it) |
| User is confirmed at their laptop and wants to hear it locally | `"play": true` |

## When to Use

- User asks you to "send a voice note", "read that out", "speak that"
- Delivering a summary or long result that's easier to listen to
- Notifications about job completion, errors, or updates
- Any time the user is on a mobile channel and audio would be better than text

## Basic Usage (Telegram / remote — default)

```
hq_call speak { "text": "Your job has completed successfully." }
```

The tool generates the audio and returns a `[FILE:]` marker. The Telegram/Discord bot automatically picks this up and sends it as a voice note to the user.

## Local playback (user is at their Mac)

```
hq_call speak { "text": "Build complete.", "play": true }
```

## Available Voices

| Voice ID | Style |
|----------|-------|
| `af_heart` | American female, warm and natural **(default)** |
| `af_nova` | American female, clear and professional |
| `am_echo` | American male, deep and confident |
| `am_onyx` | American male, authoritative |
| `bf_emma` | British female, precise and pleasant |
| `bm_george` | British male, calm and clear |

## Custom Voice Speed

```
hq_call speak { "text": "Here is your digest.", "voice": "am_echo", "speed": 0.9 }
```

## Voice Cloning (User's Own Voice)

If `.vault/_system/voice/reference.wav` exists, speak in the user's cloned voice:

```
hq_call speak { "text": "Hello.", "clone": true }
```

## How It Works

1. Kokoro-82M generates a WAV file locally (~0.3s per sentence, ~600 MB RAM)
2. Tool returns `[FILE: /tmp/hq-speech-xxx.wav | voice-af_heart.wav]`
3. Telegram/Discord bot detects the `[FILE:]` marker, converts WAV → OGG Opus via ffmpeg, sends as voice note
4. If `play: true`, also plays via `afplay` on the Mac speakers

## Setup (one-time, if not already done)

```bash
pip3.13 install kokoro-onnx soundfile   # Kokoro engine
# Model files already at .vault/_system/voice/
```
