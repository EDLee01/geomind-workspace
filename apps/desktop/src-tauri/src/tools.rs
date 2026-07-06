// Detects which scientific/runtime tools are available on the user's system.
// AI4S Workbench does not bundle Python/R/Jupyter; OpenCode's shell tool uses whatever
// is installed. This surfaces that to the UI honestly.
use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct ToolStatus {
    name: String,
    found: bool,
    version: Option<String>,
}

fn probe(name: &str, bin: &str, version_arg: &str) -> ToolStatus {
    let out = Command::new(bin).arg(version_arg).output();
    match out {
        Ok(o) if o.status.success() || !o.stdout.is_empty() || !o.stderr.is_empty() => {
            let text = if !o.stdout.is_empty() { o.stdout } else { o.stderr };
            let version = String::from_utf8_lossy(&text)
                .lines()
                .next()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            ToolStatus { name: name.to_string(), found: true, version }
        }
        _ => ToolStatus { name: name.to_string(), found: false, version: None },
    }
}

/// Report availability of the tools relevant to a research workflow.
#[tauri::command]
pub fn detect_tools() -> Vec<ToolStatus> {
    let python = {
        let p3 = probe("Python", "python3", "--version");
        if p3.found { p3 } else { probe("Python", "python", "--version") }
    };
    vec![
        python,
        probe("R", "Rscript", "--version"),
        probe("Node.js", "node", "--version"),
        probe("uv", "uv", "--version"),
        probe("Jupyter", "jupyter", "--version"),
        probe("Git", "git", "--version"),
    ]
}
