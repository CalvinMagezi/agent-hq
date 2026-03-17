#!/usr/bin/env bun
/**
 * Morning Brief Audio Generator — Fully Local Pipeline
 *
 * Flow:
 *   1. Read vault context (news pulse, memory, pinned notes)
 *   2. Generate two-host dialogue script via Ollama (qwen3.5:9b)
 *   3. TTS each segment via mlx_audio Kokoro-82M (already cached)
 *   4. Merge all segments with ffmpeg → MP3 in .vault/Notebooks/Daily Digest/
 *
 * Usage:
 *   bun scripts/morning-brief-audio.ts
 *   bun scripts/morning-brief-audio.ts --dry-run   # generate script only, no TTS
 *   bun scripts/morning-brief-audio.ts --play       # open audio when done
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "child_process";

// ── Config ────────────────────────────────────────────────────────────────────

const REPO_ROOT   = resolve(import.meta.dir, "..");
const VAULT_PATH  = process.env.VAULT_PATH ?? join(REPO_ROOT, ".vault");
const OLLAMA_URL  = process.env.OLLAMA_URL ?? "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "qwen3.5:9b";

const KOKORO_MODEL = "mlx-community/Kokoro-82M-bf16";
const PYTHON       = process.env.PYTHON_BIN   ?? resolveBin(["python3.13", "python3", "python"]);
const FFMPEG       = process.env.FFMPEG_BIN   ?? resolveBin(["ffmpeg"]);
const TMP_DIR      = "/tmp/morning-brief-audio";

/** Resolve the first binary found on PATH; falls back to the last name in the list. */
function resolveBin(names: string[]): string {
  for (const name of names) {
    const result = spawnSync("which", [name], { encoding: "utf-8", stdio: "pipe" });
    if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  }
  return names[names.length - 1]; // will produce a clear error at use-time
}

// Feature flag — default OFF. Set MORNING_BRIEF_ENABLED=true to enable.
const ENABLED = process.env.MORNING_BRIEF_ENABLED === "true";

const DRY_RUN  = process.argv.includes("--dry-run");
const AUTO_PLAY = process.argv.includes("--play");
const FORCE    = process.argv.includes("--force"); // bypass feature flag for manual runs
const VOICE_OVERRIDE = process.argv.find(a => a.startsWith("--voice="))?.split("=")[1];

// ── Voice rotation — one voice per day, cycles through the full roster ────────
const VOICE_ROSTER = [
  "af_heart",    // warm female (American)
  "am_michael",  // calm male (American)
  "af_bella",    // expressive female (American)
  "bm_george",   // authoritative male (British)
  "bf_emma",     // clear female (British)
  "af_sarah",    // bright female (American)
  "am_adam",     // deep male (American)
];

function todaysVoice(): string {
  if (VOICE_OVERRIDE) return VOICE_OVERRIDE;
  const now = new Date();
  const dayOfYear = Math.floor(
    (now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86_400_000
  );
  return VOICE_ROSTER[dayOfYear % VOICE_ROSTER.length];
}

// ── Vault helpers ─────────────────────────────────────────────────────────────

function readVaultFile(relativePath: string): string {
  try {
    return readFileSync(join(VAULT_PATH, relativePath), "utf-8");
  } catch {
    return "";
  }
}

function extractNewsPulse(heartbeat: string): string {
  // Slice everything from the comment marker to end of file — simplest, most robust
  const marker = "<!-- agent-hq-news-pulse -->";
  const idx = heartbeat.indexOf(marker);
  if (idx === -1) return "";
  return heartbeat
    .slice(idx + marker.length)
    .trim()
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'");
}

function getPinnedNotes(): Array<{ title: string; summary: string }> {
  const results: Array<{ title: string; summary: string }> = [];

  function scan(dir: string, depth = 0) {
    if (depth > 3) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          scan(fullPath, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          try {
            const content = readFileSync(fullPath, "utf-8");
            if (!content.includes("pinned: true")) continue;
            const title = entry.name.replace(".md", "");
            // Grab first non-frontmatter, non-empty line as summary
            const lines = content.split("\n").filter(l => l.trim() && !l.startsWith("---") && !l.startsWith("#") && !l.match(/^[a-zA-Z]+:/));
            const summary = lines[0]?.trim().slice(0, 120) ?? "";
            results.push({ title, summary });
          } catch {}
        }
      }
    } catch {}
  }

  scan(join(VAULT_PATH, "Notebooks"));
  return results.slice(0, 8);
}

// ── Step 1: Gather context ────────────────────────────────────────────────────

function gatherContext() {
  console.log("📚 Reading vault context...");

  const heartbeat  = readVaultFile("_system/HEARTBEAT.md");
  const memory     = readVaultFile("_system/MEMORY.md");
  const modelIntel = readVaultFile("_system/MODEL-INTELLIGENCE.md");
  const newsPulse  = extractNewsPulse(heartbeat);
  const pinned     = getPinnedNotes();

  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    timeZone: "Africa/Nairobi",
  });

  if (!newsPulse) console.warn("⚠️  No news pulse found in HEARTBEAT.md");
  console.log(`   News items: ${newsPulse.split("\n").filter(l => l.startsWith("-")).length}`);
  console.log(`   Pinned notes: ${pinned.length}`);
  console.log(`   Model intel: ${modelIntel ? "yes" : "none"}`);

  return { newsPulse, memory, modelIntel, pinned, today };
}

// ── Step 2: Generate dialogue script via Ollama ───────────────────────────────

async function generateScript(ctx: ReturnType<typeof gatherContext>): Promise<string> {
  console.log(`\n🤖 Generating dialogue script with ${OLLAMA_MODEL}...`);
  console.log("   (this takes 5–8 minutes — grab a coffee)\n");

  const pinnedList = ctx.pinned
    .map(p => `- **${p.title}**: ${p.summary}`)
    .join("\n");

  const systemPrompt = readFileSync(
    join(REPO_ROOT, "scripts/morning-brief-prompt.md"),
    "utf-8"
  );

  const userPrompt = `Today is ${ctx.today}. Generate the full morning deep dive for Calvin.

## Today's News
${ctx.newsPulse || "No news pulse available — cover recent AI, Africa tech, and geopolitics broadly."}

## Calvin's Active Projects
${pinnedList || "Agent-HQ (local AI hub), Kolaborate (African talent platform), SiteSeer, Chamuka, YMF"}

## AI Model Intelligence
${ctx.modelIntel || "No recent model intelligence available."}

## Calvin's Background (for framing)
${ctx.memory.slice(0, 2000)}

FORMAT EXAMPLE (follow this exactly):
[S1]: The Iran war just escalated significantly overnight — a US-Israeli strike hit Hamadan, which is deep inland.
[S2]: Right, and that's a big shift. Previous strikes were coastal. Going inland signals something much more serious.
[S1]: Exactly. And simultaneously there was a drone strike on Dubai airport's fuel tank.
[S2]: Which directly threatens UAE neutrality. If the Gulf states are forced to openly align, the whole regional order shifts.

Now write the full 180–220 exchange script. Start immediately with [S1]: — no intro text, no preamble, no stage directions.`;

  // Stream the response so the connection stays alive over a long generation
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
        // Prime the assistant to start in the right format immediately
        { role: "assistant", content: "[S1]:" },
      ],
      stream: true,
      options: {
        temperature: 0.75,
        num_predict: 9000,
        top_p: 0.9,
        repeat_penalty: 1.1,
      },
    }),
    signal: AbortSignal.timeout(20 * 60 * 1000), // 20 min hard ceiling
  });

  if (!response.ok) {
    throw new Error(`Ollama error ${response.status}: ${await response.text()}`);
  }

  // Accumulate streamed tokens, printing a dot every 100 tokens
  let raw = "[S1]:"; // include the primed prefix
  let tokenCount = 0;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split("\n")) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line) as { message?: { content: string }; done: boolean };
        if (chunk.message?.content) {
          raw += chunk.message.content;
          tokenCount++;
          if (tokenCount % 100 === 0) process.stdout.write(".");
        }
        if (chunk.done) break outer;
      } catch {}
    }
  }
  console.log(` (${tokenCount} tokens)`);

  // Strip thinking tokens (qwen3.5 chain-of-thought) and code fences
  const script = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/^```[\w]*\n?/gm, "")
    .replace(/^```\s*$/gm, "")
    .trim();

  const exchangeCount = script.split("\n").filter(l => /^\[S[12]\]:/.test(l)).length;
  console.log(`✅ Script generated: ${exchangeCount} exchanges, ~${Math.round(script.split(" ").length / 150)} min estimated`);

  return script;
}

// ── Step 3: Parse script into segments ────────────────────────────────────────

interface Segment {
  index: number;
  speaker: "S1" | "S2";
  text: string;
}

function parseScript(script: string): Segment[] {
  const segments: Segment[] = [];
  let index = 0;

  for (const line of script.split("\n")) {
    const m = line.match(/^\[S([12])\]:\s*(.+)/);
    if (!m) continue;
    const text = m[2].trim();
    if (!text) continue;
    segments.push({ index: index++, speaker: `S${m[1]}` as "S1" | "S2", text });
  }

  console.log(`\n📝 Parsed ${segments.length} segments`);

  if (segments.length < 20) {
    console.warn("⚠️  Low segment count — script may be malformed. First 3 lines:");
    script.split("\n").slice(0, 3).forEach(l => console.warn("   " + l));
  }

  return segments;
}

// ── Step 4: TTS each segment via mlx_audio Kokoro ────────────────────────────

function generateTTS(segments: Segment[]): string[] {
  // Clean up temp dir
  if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true });
  mkdirSync(TMP_DIR, { recursive: true });

  const audioFiles: string[] = [];
  const total = segments.length;
  const voice = todaysVoice();

  console.log(`\n🎙️  Generating TTS for ${total} segments...`);
  console.log(`   Voice: Kokoro ${voice} (day-${new Date().toLocaleDateString("en-CA")})\n`);

  const startTime = Date.now();

  for (const seg of segments) {
    const padded  = String(seg.index).padStart(4, "0");
    const segDir  = join(TMP_DIR, padded);
    const outFile = join(segDir, "out.wav");

    mkdirSync(segDir, { recursive: true });

    if (seg.index % 25 === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`   [${seg.index}/${total}] ${elapsed}s elapsed...`);
    }

    const result = spawnSync(PYTHON, [
      "-m", "mlx_audio.tts.generate",
      "--model",       KOKORO_MODEL,
      "--text",        seg.text,
      "--voice",       voice,
      "--output_path", segDir,
      "--file_prefix", "out",
      "--audio_format","wav",
      "--join_audio",
      "--max_tokens",  "1200",
      "--speed",       "1.05",
    ], {
      encoding: "utf-8",
      stdio:    ["ignore", "pipe", "pipe"],
      timeout:  90_000,
    });

    if (result.status !== 0) {
      console.warn(`   ⚠️  Segment ${seg.index} failed: ${result.stderr?.slice(0, 80)}`);
      continue;
    }

    // mlx_audio with --join_audio outputs one file; find it
    const files = existsSync(segDir)
      ? readdirSync(segDir)
          .filter(f => f.endsWith(".wav"))
          .sort()
          .map(f => join(segDir, f))
      : [];

    if (files.length === 0) {
      console.warn(`   ⚠️  No wav output for segment ${seg.index}`);
      continue;
    }

    // Take the last file (the joined one if multiple were created)
    audioFiles.push(files[files.length - 1]);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ TTS complete: ${audioFiles.length}/${total} segments in ${elapsed}s`);

  return audioFiles;
}

// ── Step 5: Merge with ffmpeg ─────────────────────────────────────────────────

function mergeAudio(audioFiles: string[], outputPath: string): void {
  console.log(`\n🎚️  Merging ${audioFiles.length} segments with ffmpeg...`);

  const concatFile = join(TMP_DIR, "concat.txt");
  writeFileSync(concatFile, audioFiles.map(f => `file '${f}'`).join("\n"));

  mkdirSync(join(VAULT_PATH, "Notebooks/Daily Digest"), { recursive: true });

  const result = spawnSync(FFMPEG, [
    "-f", "concat",
    "-safe", "0",
    "-i", concatFile,
    "-c:a", "libmp3lame",
    "-q:a", "3",          // high quality VBR
    "-ar", "24000",
    "-y",
    outputPath,
  ], {
    encoding: "utf-8",
    stdio:    ["ignore", "pipe", "pipe"],
    timeout:  120_000,
  });

  if (result.status !== 0) {
    throw new Error(`ffmpeg merge failed:\n${result.stderr}`);
  }
}

// ── Step 6: Deliver — Drive upload + optional Telegram ───────────────────────

const GWS     = process.env.GWS_BIN  ?? resolveBin(["gws"]);
const CURL    = process.env.CURL_BIN ?? resolveBin(["curl"]);

interface DeliveryResult {
  driveLink: string | null;
  telegramSent: boolean;
}

async function deliver(audioPath: string, dateStr: string, estimatedMin: number): Promise<DeliveryResult> {
  const result: DeliveryResult = { driveLink: null, telegramSent: false };

  // ── Google Drive upload ──────────────────────────────────────────────────
  console.log("\n☁️  Uploading to Google Drive...");
  const uploadResult = spawnSync(GWS, [
    "drive", "files", "create",
    "--params", JSON.stringify({ fields: "id,name,webViewLink" }),
    "--json",   JSON.stringify({ name: `Morning Brief — ${dateStr}`, mimeType: "audio/mpeg" }),
    "--upload", audioPath,
  ], { encoding: "utf-8", timeout: 60_000 });

  if (uploadResult.status === 0) {
    try {
      const data = JSON.parse(uploadResult.stdout.trim()) as { id: string; webViewLink: string };

      // Share with anyone-who-has-the-link so it opens without signing in
      spawnSync(GWS, [
        "drive", "permissions", "create",
        "--params", JSON.stringify({ fileId: data.id, fields: "id" }),
        "--json",   JSON.stringify({ role: "reader", type: "anyone" }),
      ], { encoding: "utf-8", timeout: 15_000 });

      result.driveLink = data.webViewLink;
      console.log(`   ✅ Drive: ${result.driveLink}`);

      // Save link to vault for reference
      const linkFile = audioPath.replace(".mp3", "-drive-link.txt");
      writeFileSync(linkFile, result.driveLink);
    } catch {
      console.warn("   ⚠️  Drive upload succeeded but couldn't parse response");
    }
  } else {
    console.warn(`   ⚠️  Drive upload failed: ${uploadResult.stderr?.slice(0, 120)}`);
  }

  // ── Telegram notification (optional) ────────────────────────────────────
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId   = process.env.TELEGRAM_USER_ID;

  if (botToken && chatId) {
    console.log("📱 Sending Telegram notification...");

    // Use HTML parse mode — more forgiving than Markdown with special chars in URLs
    const message = result.driveLink
      ? `🌅 <b>Morning Brief — ${dateStr}</b>\n\n~${estimatedMin} minutes · ${todaysVoice()} voice\n\n<a href="${result.driveLink}">▶️ Listen on Drive</a>`
      : `🌅 <b>Morning Brief — ${dateStr}</b> generated (~${estimatedMin} min). Drive upload failed — check vault.`;

    const tgResult = spawnSync(CURL, [
      "-s", "-X", "POST",
      `https://api.telegram.org/bot${botToken}/sendMessage`,
      "-d", `chat_id=${chatId}&parse_mode=HTML&text=${encodeURIComponent(message)}`,
    ], { encoding: "utf-8", timeout: 15_000 });

    if (tgResult.status === 0) {
      try {
        const resp = JSON.parse(tgResult.stdout) as { ok: boolean };
        if (resp.ok) {
          result.telegramSent = true;
          console.log("   ✅ Telegram notification sent");
        } else {
          console.warn(`   ⚠️  Telegram API error: ${tgResult.stdout.slice(0, 120)}`);
        }
      } catch {
        console.warn("   ⚠️  Couldn't parse Telegram response");
      }
    } else {
      console.warn(`   ⚠️  Telegram request failed: ${tgResult.stderr?.slice(0, 80)}`);
    }
  } else if (!DRY_RUN) {
    console.log("   ℹ️  Telegram not configured (add TELEGRAM_BOT_TOKEN + TELEGRAM_USER_ID to .env.local)");
  }

  return result;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Feature flag — exit cleanly if not enabled (allows safe daemon invocation)
  if (!ENABLED && !FORCE && !DRY_RUN) {
    console.log("Morning brief is disabled. Set MORNING_BRIEF_ENABLED=true to enable, or run with --force.");
    process.exit(0);
  }

  const now      = new Date();
  const dateStr  = now.toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" }); // YYYY-MM-DD
  const digestDir = join(VAULT_PATH, "Notebooks/Daily Digest");
  const outAudio  = join(digestDir, `Brief-${dateStr}.mp3`);
  const outScript = join(digestDir, `Brief-${dateStr}-script.md`);

  console.log("🌅 Morning Brief Audio Generator — Fully Local");
  console.log(`   Model:  ${OLLAMA_MODEL} (Ollama)`);
  console.log(`   Voice:  Kokoro ${todaysVoice()} (rotates daily)`);
  console.log(`   Output: ${outAudio}`);
  if (DRY_RUN) console.log("   Mode:   DRY RUN (script only, no TTS)");
  console.log("");

  // Step 1
  const ctx = gatherContext();

  // Step 2
  const script = await generateScript(ctx);

  // Save script always
  mkdirSync(digestDir, { recursive: true });
  writeFileSync(outScript,
    `---\nnoteType: note\ntags: [daily-brief, script]\npinned: false\ncreatedAt: ${now.toISOString()}\n---\n\n# Morning Brief Script — ${dateStr}\n\n${script}`
  );
  console.log(`📄 Script saved → ${outScript}`);

  if (DRY_RUN) {
    console.log("\n✅ Dry run complete — script generated, TTS skipped.");
    return;
  }

  // Step 3
  const segments = parseScript(script);
  if (segments.length < 20) {
    throw new Error(`Too few segments (${segments.length}) — aborting TTS to avoid wasted compute`);
  }

  // Step 4
  const audioFiles = generateTTS(segments);
  if (audioFiles.length === 0) {
    throw new Error("No audio files generated — check mlx_audio / Python path");
  }

  // Step 5
  mergeAudio(audioFiles, outAudio);

  const estimatedMin = Math.round(segments.length * 8 / 60);

  // Step 6: deliver
  const delivery = await deliver(outAudio, dateStr, estimatedMin);

  // Done
  console.log("\n✅ Morning brief ready!");
  console.log(`   Audio:    ${outAudio}`);
  console.log(`   Script:   ${outScript}`);
  console.log(`   ~${estimatedMin} minutes of audio`);
  console.log(`   Segments: ${audioFiles.length}`);
  if (delivery.driveLink)    console.log(`   Drive:    ${delivery.driveLink}`);
  if (delivery.telegramSent) console.log(`   Telegram: notified ✅`);

  if (AUTO_PLAY && process.platform === "darwin") {
    spawnSync("open", [outAudio], { stdio: "ignore" });
    console.log("   ▶️  Opening in default audio player...");
  }
}

main().catch(err => {
  console.error("\n❌ Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
