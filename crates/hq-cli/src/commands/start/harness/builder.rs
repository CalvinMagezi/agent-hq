//! Harness command builder — constructs CLI args for each supported harness.

/// Build CLI command args for a given harness.
///
/// Returns `(program, args, supports_resume)`.
pub fn build_harness_command(
    harness: &str,
    prompt: &str,
    session_id: Option<&str>,
) -> (String, Vec<String>, bool) {
    match harness {
        "claude-code" => {
            let mut args = vec![
                "--dangerously-skip-permissions".to_string(),
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--verbose".to_string(),
                "--max-turns".to_string(),
                "100".to_string(),
                "--model".to_string(),
                "opus".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--resume".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("claude".to_string(), args, true)
        }
        "opencode" => {
            let mut args = vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--continue".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("opencode".to_string(), args, true)
        }
        "gemini-cli" => {
            let args = vec!["-p".to_string(), prompt.to_string()];
            ("gemini".to_string(), args, false)
        }
        "codex-cli" => {
            if let Some(sid) = session_id {
                let args = vec![
                    "exec".to_string(),
                    "resume".to_string(),
                    sid.to_string(),
                    "--json".to_string(),
                    "--full-auto".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                ];
                ("codex".to_string(), args, true)
            } else {
                let args = vec![
                    "exec".to_string(),
                    "--json".to_string(),
                    "--full-auto".to_string(),
                    "--color".to_string(),
                    "never".to_string(),
                    "-p".to_string(),
                    prompt.to_string(),
                ];
                ("codex".to_string(), args, true)
            }
        }
        "qwen-code" => {
            let mut args = vec![
                "--output-format".to_string(),
                "stream-json".to_string(),
                "--include-partial-messages".to_string(),
                "--yolo".to_string(),
            ];
            if let Some(sid) = session_id {
                args.push("--continue".to_string());
                args.push(sid.to_string());
            }
            args.push("-p".to_string());
            args.push(prompt.to_string());
            ("qwen".to_string(), args, true)
        }
        "kilo-code" => {
            let args = vec![
                "run".to_string(),
                "--format".to_string(),
                "json".to_string(),
                "--auto".to_string(),
                prompt.to_string(),
            ];
            ("kilo".to_string(), args, false)
        }
        "mistral-vibe" => {
            let args = vec![
                "--prompt".to_string(),
                prompt.to_string(),
                "--output".to_string(),
                "streaming".to_string(),
                "--max-turns".to_string(),
                "30".to_string(),
                "--max-price".to_string(),
                "0.50".to_string(),
            ];
            ("vibe".to_string(), args, false)
        }
        _ => {
            // Should not happen; fallback to claude-code
            build_harness_command("claude-code", prompt, session_id)
        }
    }
}
