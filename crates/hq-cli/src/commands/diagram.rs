use anyhow::Result;
use hq_core::config::HqConfig;
use std::process::Command;

/// Generate diagrams via the DrawIt CLI.
pub async fn run(config: &HqConfig, sub: &str, args: &[String]) -> Result<()> {
    // Locate drawit binary
    let drawit = find_drawit()?;

    let vault_path = &config.vault_path;
    let diagrams_dir = vault_path.join("Notebooks/Diagrams");
    std::fs::create_dir_all(&diagrams_dir)?;

    match sub {
        "help" | "" => {
            println!("hq diagram — Fast diagram pipeline\n");
            println!("USAGE");
            println!("  hq diagram flow \"Step 1\" \"Step 2\" \"Decision?\" \"End\"");
            println!("  hq diagram map [path]");
            println!("  hq diagram deps [path]");
            println!("  hq diagram routes [path]");
            println!("  hq diagram render <file.drawit>");
            println!("  hq diagram create --title \"Name\" --nodes \"A,B,C\" --edges \"A>B,B>C\"\n");
            println!("OUTPUT");
            println!("  Source .drawit files saved to .vault/Notebooks/Diagrams/");
        }
        "flow" => {
            let steps: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
            if steps.is_empty() {
                anyhow::bail!("No steps provided. Usage: hq diagram flow \"Step 1\" \"Step 2\" ...");
            }
            let name = extract_flag(args, "--name").unwrap_or_else(|| "flow".to_string());
            let output = diagrams_dir.join(format!("{}.drawit", safe_name(&name)));

            let mut cmd_args: Vec<String> = vec!["flow".to_string()];
            for step in &steps {
                cmd_args.push(step.to_string());
            }
            cmd_args.push("--output".to_string());
            cmd_args.push(output.to_string_lossy().to_string());

            run_drawit(&drawit, &cmd_args)?;
            println!("Created: {}", output.display());
        }
        "map" | "deps" | "routes" => {
            let target = args.first().map(|s| s.as_str()).unwrap_or(".");
            let dir_name = safe_name(
                std::path::Path::new(target)
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .as_ref(),
            );
            let output = diagrams_dir.join(format!("{}-{}.drawit", dir_name, sub));

            let mut cmd_args = vec![sub.to_string(), target.to_string()];
            cmd_args.push("--output".to_string());
            cmd_args.push(output.to_string_lossy().to_string());

            // Pass through additional flags
            for arg in args.iter().skip(1) {
                if arg.starts_with("--") {
                    cmd_args.push(arg.clone());
                }
            }

            run_drawit(&drawit, &cmd_args)?;
            println!("Created: {}", output.display());
        }
        "render" => {
            let file = args
                .first()
                .ok_or_else(|| anyhow::anyhow!("Usage: hq diagram render <file.drawit>"))?;

            if !std::path::Path::new(file).exists() {
                anyhow::bail!("File not found: {}", file);
            }

            let output_svg = format!("{}.svg", file.trim_end_matches(".drawit"));
            run_drawit(
                &drawit,
                &[
                    "export".to_string(),
                    file.to_string(),
                    "--format".to_string(),
                    "svg".to_string(),
                    "--output".to_string(),
                    output_svg.clone(),
                ],
            )?;
            println!("Exported: {}", output_svg);
        }
        "create" => {
            let title = extract_flag(args, "--title").unwrap_or_else(|| "diagram".to_string());
            let nodes_str = extract_flag(args, "--nodes");
            let edges_str = extract_flag(args, "--edges");

            if nodes_str.is_none() {
                anyhow::bail!(
                    "Usage: hq diagram create --title 'Name' --nodes 'A,B,C' --edges 'A>B,B>C'"
                );
            }

            let nodes: Vec<&str> = nodes_str
                .as_ref()
                .unwrap()
                .split(',')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();

            let output = diagrams_dir.join(format!("{}.drawit", safe_name(&title)));

            // Generate NDJSON diagram manually
            let cols = (nodes.len() as f64).sqrt().ceil() as usize;
            let node_w = 180;
            let node_h = 60;
            let gap_x = 80;
            let gap_y = 80;
            let pad = 80;

            let canvas_w = pad * 2 + cols * node_w + cols.saturating_sub(1) * gap_x;
            let rows = (nodes.len() + cols - 1) / cols;
            let canvas_h = pad * 2 + rows * node_h + rows.saturating_sub(1) * gap_y;

            let mut lines = Vec::new();
            lines.push(serde_json::json!({
                "width": canvas_w,
                "height": canvas_h,
                "background": "#0a0f1e",
                "metadata": {"name": title, "diagramType": "architecture"}
            }));

            let palette = ["#1e3a5f", "#2d4a3f", "#4a2d5f", "#5f3a1e", "#1e5f5a", "#5f1e3a"];
            let strokes = ["#3b82f6", "#34d399", "#a78bfa", "#f59e0b", "#22d3ee", "#f87171"];

            let mut node_ids: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            for (i, label) in nodes.iter().enumerate() {
                let id = format!("n{}", i);
                node_ids.insert(label.to_string(), id.clone());
                let col = i % cols;
                let row = i / cols;
                let x = pad + col * (node_w + gap_x);
                let y = pad + row * (node_h + gap_y);
                let ci = i % palette.len();

                lines.push(serde_json::json!({
                    "id": id,
                    "type": "node",
                    "position": {"x": x, "y": y},
                    "size": {"width": node_w, "height": node_h},
                    "shape": "rectangle",
                    "zIndex": 2,
                    "style": {
                        "fillStyle": palette[ci],
                        "strokeStyle": strokes[ci],
                        "lineWidth": 2,
                    },
                    "text": {
                        "content": label,
                        "fontSize": 14,
                        "color": "#e2e8f0",
                        "textAlign": "center",
                    },
                }));
            }

            if let Some(edges) = &edges_str {
                for (i, pair) in edges.split(',').enumerate() {
                    let parts: Vec<&str> = pair.split('>').map(|s| s.trim()).collect();
                    if parts.len() == 2 {
                        if let (Some(src), Some(tgt)) =
                            (node_ids.get(parts[0]), node_ids.get(parts[1]))
                        {
                            lines.push(serde_json::json!({
                                "id": format!("e{}", i),
                                "type": "edge",
                                "source": src,
                                "target": tgt,
                                "zIndex": 1,
                                "style": {
                                    "strokeStyle": "#94a3b8",
                                    "lineWidth": 2,
                                    "arrowheadEnd": true,
                                },
                            }));
                        }
                    }
                }
            }

            let content: String = lines
                .iter()
                .map(|l| serde_json::to_string(l).unwrap())
                .collect::<Vec<_>>()
                .join("\n")
                + "\n";

            std::fs::write(&output, content)?;
            println!("Created: {}", output.display());
        }
        _ => {
            anyhow::bail!("Unknown diagram subcommand: {}. Run 'hq diagram help' for usage.", sub);
        }
    }

    Ok(())
}

fn find_drawit() -> Result<String> {
    // Check PATH first
    if let Ok(output) = Command::new("which").arg("drawit").output() {
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).trim().to_string());
        }
    }

    // Fallback locations
    let fallbacks = ["/opt/homebrew/bin/drawit", "/usr/local/bin/drawit"];
    for path in &fallbacks {
        if std::path::Path::new(path).exists() {
            return Ok(path.to_string());
        }
    }

    anyhow::bail!("DrawIt CLI not found. Install: npm i -g @chamuka-labs/drawit-cli")
}

fn run_drawit(binary: &str, args: &[String]) -> Result<()> {
    let output = Command::new(binary).args(args).output()?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        anyhow::bail!("drawit failed: {}", stderr.trim());
    }

    Ok(())
}

fn safe_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

fn extract_flag(args: &[String], flag: &str) -> Option<String> {
    args.iter()
        .position(|a| a == flag)
        .and_then(|i| args.get(i + 1).cloned())
}
