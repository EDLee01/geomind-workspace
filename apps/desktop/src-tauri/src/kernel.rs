// Local notebook kernels. One persistent child per language ("python" | "r"),
// each holding shared state across cells like a Jupyter kernel. Fully local —
// uses whatever Python/R is installed, no network, no model key.
//
// Wire protocol (one request, one response line):
//   - Python: write {"id","code"} JSON; the bridge replies with a JSON line.
//   - R:      write the cell code to the kernel's code file, then send "<id>";
//             the bridge reads that file and replies with the SAME JSON shape.
// The read side is therefore identical for both languages.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

// The bridge scripts ship in-tree; embed them and materialize on first use so
// they are always present next to the app regardless of packaging.
const PY_BRIDGE_SRC: &str = include_str!("../../../../runtime/kernel/kernel_bridge.py");
const R_BRIDGE_SRC: &str = include_str!("../../../../runtime/kernel/kernel_bridge.R");

struct Kernel {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    seq: u64,
    /// For the R kernel: the file the host writes each cell's code into. None for Python.
    code_file: Option<PathBuf>,
}

/// Persistent kernels keyed by `kernel_key` — one per notebook (Jupyter
/// semantics: each notebook gets its own kernel, cwd = the notebook's folder,
/// no state bleed between notebooks).
#[derive(Default)]
pub struct KernelState(Mutex<HashMap<String, Kernel>>);

/// Map key for a kernel: `<lang>:<absolute notebook path>`, or `<lang>:@workspace`
/// for legacy notebook-less execution in the active workspace.
fn kernel_key(lang: &str, notebook_abs: Option<&std::path::Path>) -> String {
    match notebook_abs {
        Some(p) => format!("{lang}:{}", p.to_string_lossy()),
        None => format!("{lang}:@workspace"),
    }
}

/// Stable filename suffix for per-kernel scratch files (the R code file).
fn key_hash(key: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    key.hash(&mut h);
    format!("{:016x}", h.finish())
}

#[derive(serde::Serialize)]
pub struct ExecResult {
    ok: bool,
    stdout: String,
    result: Option<String>,
    error: Option<String>,
}

/// Normalize a requested language to a supported kernel id. Empty -> python.
fn normalize_lang(language: &str) -> Result<&'static str, String> {
    match language.trim().to_ascii_lowercase().as_str() {
        "" | "python" | "python3" => Ok("python"),
        "r" => Ok("r"),
        other => Err(format!("unsupported kernel language: {other}")),
    }
}

fn kernel_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime")
        .join("kernel");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

// Rewrite the bridge each start so an app update ships a fresh copy.
fn materialize(app: &AppHandle, name: &str, src: &str) -> Result<PathBuf, String> {
    let path = kernel_dir(app)?.join(name);
    std::fs::write(&path, src).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Common Python install locations per OS. A GUI app launched from Finder/Explorer
/// has a minimal PATH, so we fall back to these before giving up.
#[cfg(windows)]
fn python_candidates() -> Vec<String> {
    // `py` (the launcher) and `python` are what Windows installers register.
    let mut c = vec!["py".to_string(), "python".to_string(), "python3".to_string()];
    if let Ok(profile) = std::env::var("USERPROFILE") {
        c.push(format!("{profile}\\anaconda3\\python.exe"));
        c.push(format!("{profile}\\miniconda3\\python.exe"));
        c.push(format!("{profile}\\AppData\\Local\\Programs\\Python\\python.exe"));
    }
    c
}

#[cfg(not(windows))]
fn python_candidates() -> Vec<String> {
    let mut c = vec!["python3".to_string(), "python".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        c.push(format!("{home}/anaconda3/bin/python3"));
        c.push(format!("{home}/miniconda3/bin/python3"));
        c.push(format!("{home}/.pyenv/shims/python3"));
    }
    c.extend(
        [
            "/opt/anaconda3/bin/python3",
            "/opt/homebrew/bin/python3",
            "/usr/local/bin/python3",
            "/usr/bin/python3",
        ]
        .map(String::from),
    );
    c
}

/// Common Rscript locations (same minimal-PATH problem as Python).
#[cfg(windows)]
fn rscript_candidates() -> Vec<String> {
    let mut c = vec!["Rscript".to_string(), "Rscript.exe".to_string()];
    for base in [
        "C:\\Program Files\\R",
        "C:\\Program Files (x86)\\R",
    ] {
        // Newest install layout: <base>\R-x.y.z\bin\Rscript.exe — probed via PATH first,
        // this literal fallback covers the common single-version install.
        c.push(format!("{base}\\bin\\Rscript.exe"));
    }
    c
}

#[cfg(not(windows))]
fn rscript_candidates() -> Vec<String> {
    let mut c = vec!["Rscript".to_string()];
    if let Ok(home) = std::env::var("HOME") {
        c.push(format!("{home}/anaconda3/bin/Rscript"));
        c.push(format!("{home}/miniconda3/bin/Rscript"));
    }
    c.extend(
        [
            "/opt/homebrew/bin/Rscript",
            "/usr/local/bin/Rscript",
            "/opt/anaconda3/bin/Rscript",
            "/usr/bin/Rscript",
            // macOS R.framework install (r-project.org .pkg)
            "/Library/Frameworks/R.framework/Resources/bin/Rscript",
        ]
        .map(String::from),
    );
    c
}

/// Probe an interpreter with the SAME PATH the kernel will run it under, so
/// detection and execution resolve to the same binary (e.g. bare `python3` →
/// the user's anaconda, not a system Python).
fn interpreter_ok(bin: &str) -> bool {
    let mut c = Command::new(bin);
    c.arg("--version");
    #[cfg(unix)]
    c.env("PATH", crate::runtime::enriched_path());
    c.output().is_ok()
}

pub(crate) fn python_bin() -> Option<String> {
    python_candidates().into_iter().find(|bin| interpreter_ok(bin))
}

pub(crate) fn rscript_bin() -> Option<String> {
    rscript_candidates().into_iter().find(|bin| interpreter_ok(bin))
}

fn spawn_kernel(app: &AppHandle, lang: &str, cwd: &std::path::Path, key: &str) -> Result<Kernel, String> {
    let (mut cmd, code_file) = match lang {
        "python" => {
            let script = materialize(app, "kernel_bridge.py", PY_BRIDGE_SRC)?;
            let python = python_bin().ok_or(
                "no Python found — install Python 3 to run Python notebooks",
            )?;
            let mut c = Command::new(python);
            c.arg(script);
            (c, None)
        }
        "r" => {
            let script = materialize(app, "kernel_bridge.R", R_BRIDGE_SRC)?;
            let rscript = rscript_bin().ok_or(
                "no R found — install R (r-project.org) to run R notebooks",
            )?;
            // One code file per kernel — concurrent R notebooks must not share it.
            let code_file = kernel_dir(app)?.join(format!("r_cell_{}.R", key_hash(key)));
            std::fs::write(&code_file, "").map_err(|e| e.to_string())?;
            let mut c = Command::new(rscript);
            c.arg(script).arg(&code_file);
            (c, Some(code_file))
        }
        _ => return Err(format!("unsupported kernel language: {lang}")),
    };
    cmd.current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // Give the kernel the SAME PATH as the OpenCode sidecar so it runs the
    // user's scientific Python (anaconda/homebrew) — the one the agent uses,
    // with numpy/matplotlib/etc. A Finder-launched app otherwise has a minimal
    // PATH and `python3` resolves to a bare system Python (no matplotlib).
    #[cfg(unix)]
    cmd.env("PATH", crate::runtime::enriched_path());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to start {lang} kernel: {e}"))?;
    let stdin = child.stdin.take().ok_or("no kernel stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("no kernel stdout")?);
    Ok(Kernel { child, stdin, stdout, seq: 0, code_file })
}

/// Send one request to a running kernel and read its single JSON response line.
fn exec_on(k: &mut Kernel, code: &str) -> Result<ExecResult, String> {
    k.seq += 1;
    match &k.code_file {
        // R: stage the code in the kernel's file, then poke it with the id.
        Some(path) => {
            std::fs::write(path, code).map_err(|e| format!("kernel write failed: {e}"))?;
            writeln!(k.stdin, "{}", k.seq).map_err(|e| format!("kernel write failed: {e}"))?;
        }
        // Python: send the code inline as JSON.
        None => {
            let req = serde_json::json!({ "id": k.seq.to_string(), "code": code });
            writeln!(k.stdin, "{req}").map_err(|e| format!("kernel write failed: {e}"))?;
        }
    }
    k.stdin.flush().map_err(|e| format!("kernel flush failed: {e}"))?;

    let mut line = String::new();
    let n = k
        .stdout
        .read_line(&mut line)
        .map_err(|e| format!("kernel read failed: {e}"))?;
    if n == 0 {
        return Err("kernel exited unexpectedly".into());
    }
    let v: serde_json::Value =
        serde_json::from_str(line.trim()).map_err(|e| format!("bad kernel response: {e}"))?;
    Ok(ExecResult {
        ok: v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false),
        stdout: v.get("stdout").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        result: v.get("result").and_then(|x| x.as_str()).map(str::to_string),
        error: v.get("error").and_then(|x| x.as_str()).map(str::to_string),
    })
}

/// Execute one cell in the persistent local kernel for this notebook (Jupyter
/// semantics: one kernel per notebook, working directory = the notebook's
/// folder), starting it on first use. `notebook` is a `root`-relative .ipynb
/// path; without it the kernel runs in the active workspace (legacy behavior).
#[tauri::command]
pub fn kernel_execute(
    app: AppHandle,
    state: State<'_, KernelState>,
    code: String,
    language: Option<String>,
    notebook: Option<String>,
    root: Option<String>,
) -> Result<ExecResult, String> {
    let lang = normalize_lang(language.as_deref().unwrap_or("python"))?;
    let (cwd, key) = match notebook.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(nb) => {
            let scope = crate::artifact_file::scope_root(&app, root.as_deref())?;
            let abs = crate::artifact_file::resolve_under(&scope, nb)?;
            let dir = abs
                .parent()
                .ok_or("notebook has no parent directory")?
                .to_path_buf();
            (dir, kernel_key(lang, Some(&abs)))
        }
        None => (crate::runtime::workspace_dir(&app)?, kernel_key(lang, None)),
    };
    let mut guard = state.0.lock().unwrap();
    if !guard.contains_key(&key) {
        let k = spawn_kernel(&app, lang, &cwd, &key)?;
        guard.insert(key.clone(), k);
    }
    let k = guard.get_mut(&key).unwrap();
    match exec_on(k, &code) {
        Ok(r) => Ok(r),
        Err(e) => {
            // The child likely died; drop it so the next call respawns cleanly.
            guard.remove(&key);
            Err(e)
        }
    }
}

/// Restart kernels (clears their state). Omit `language` to reset everything;
/// with `language`, every kernel of that language is killed.
#[tauri::command]
pub fn kernel_reset(state: State<'_, KernelState>, language: Option<String>) {
    let mut guard = state.0.lock().unwrap();
    match language.as_deref().and_then(|l| normalize_lang(l).ok()) {
        Some(lang) => {
            let prefix = format!("{lang}:");
            let keys: Vec<String> = guard.keys().filter(|k| k.starts_with(&prefix)).cloned().collect();
            for key in keys {
                if let Some(mut k) = guard.remove(&key) {
                    let _ = k.child.kill();
                }
            }
        }
        None => {
            for (_, mut k) in guard.drain() {
                let _ = k.child.kill();
            }
        }
    }
}

pub fn kill_kernel(state: &KernelState) {
    for (_, mut k) in state.0.lock().unwrap().drain() {
        let _ = k.child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(stdout: &mut BufReader<ChildStdout>) -> serde_json::Value {
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        serde_json::from_str(line.trim()).unwrap()
    }

    #[test]
    fn kernel_keys_isolate_notebooks_and_languages() {
        let a = std::path::Path::new("/ws/2026-07-05/analysis.ipynb");
        let b = std::path::Path::new("/ws/2026-07-04/analysis.ipynb");
        // Same basename in different folders → different kernels; language
        // is part of the key; the legacy no-notebook key stays stable.
        assert_ne!(kernel_key("python", Some(a)), kernel_key("python", Some(b)));
        assert_ne!(kernel_key("python", Some(a)), kernel_key("r", Some(a)));
        assert_eq!(kernel_key("python", None), "python:@workspace");
        // Distinct keys get distinct R scratch files.
        assert_ne!(
            key_hash(&kernel_key("r", Some(a))),
            key_hash(&kernel_key("r", Some(b)))
        );
    }

    #[test]
    fn normalizes_languages() {
        assert_eq!(normalize_lang("").unwrap(), "python");
        assert_eq!(normalize_lang("Python3").unwrap(), "python");
        assert_eq!(normalize_lang("R").unwrap(), "r");
        assert!(normalize_lang("julia").is_err());
    }

    // Drives the real in-tree Python bridge with the same JSON protocol
    // kernel_execute uses, proving the Rust <-> Python round trip and shared state.
    #[test]
    fn python_round_trips_and_keeps_state() {
        let Some(python) = python_bin() else {
            eprintln!("skipping: no python found");
            return;
        };
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../runtime/kernel/kernel_bridge.py");
        let mut child = Command::new(python)
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bridge");
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());

        writeln!(stdin, "{}", serde_json::json!({"id":"1","code":"a=41\na+1"})).unwrap();
        stdin.flush().unwrap();
        let r1 = read(&mut stdout);
        assert_eq!(r1["ok"], true);
        assert_eq!(r1["result"], "42");

        // Second cell sees `a` from the first — persistent shared namespace.
        writeln!(stdin, "{}", serde_json::json!({"id":"2","code":"a"})).unwrap();
        stdin.flush().unwrap();
        let r2 = read(&mut stdout);
        assert_eq!(r2["result"], "41");

        // Errors come back as ok:false with a traceback.
        writeln!(stdin, "{}", serde_json::json!({"id":"3","code":"1/0"})).unwrap();
        stdin.flush().unwrap();
        let r3 = read(&mut stdout);
        assert_eq!(r3["ok"], false);
        assert!(r3["error"].as_str().unwrap().contains("ZeroDivisionError"));

        let _ = child.kill();
    }

    // Same round trip against the real R bridge (skipped if R is not installed):
    // shared state across cells, last-expression value, and error reporting.
    #[test]
    fn r_round_trips_and_keeps_state() {
        let Some(rscript) = rscript_bin() else {
            eprintln!("skipping: no Rscript found");
            return;
        };
        let script = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../runtime/kernel/kernel_bridge.R");
        let dir = std::env::temp_dir().join("os_r_kernel_test");
        std::fs::create_dir_all(&dir).unwrap();
        let code_file = dir.join("r_cell.R");
        std::fs::write(&code_file, "").unwrap();
        let mut child = Command::new(rscript)
            .arg(script)
            .arg(&code_file)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn R bridge");
        let mut stdin = child.stdin.take().unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut poke = |code: &str, id: &str| {
            std::fs::write(&code_file, code).unwrap();
            writeln!(stdin, "{id}").unwrap();
            stdin.flush().unwrap();
        };

        poke("a <- 41\na + 1", "1");
        let r1 = read(&mut stdout);
        assert_eq!(r1["ok"], true);
        assert_eq!(r1["result"], "[1] 42");

        // `a` persists into the next cell.
        poke("a", "2");
        let r2 = read(&mut stdout);
        assert_eq!(r2["result"], "[1] 41");

        // stdout is captured; the final visible value is the result.
        poke("cat('hi\\n')\n2 + 2", "3");
        let r3 = read(&mut stdout);
        assert_eq!(r3["stdout"].as_str().unwrap().trim(), "hi");
        assert_eq!(r3["result"], "[1] 4");

        // Errors -> ok:false with a message.
        poke("stop('boom')", "4");
        let r4 = read(&mut stdout);
        assert_eq!(r4["ok"], false);
        assert!(r4["error"].as_str().unwrap().contains("boom"));

        let _ = child.kill();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
