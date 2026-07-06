// Manages the bundled Magi daemon so it never interferes with any Magi the user
// already has: it runs the *bundled* `magi` CLI, on a *dedicated free port*,
// with an *app-private* MAGI_CONFIG_DIR (its own ~/.magi-next equivalent), and
// is killed on app exit. The frontend's MagiClient pairs over loopback and
// reads the audit SSE stream; this module only owns the process + config.yaml.
//
// NOTE: part of the OpenCode→Magi runtime migration, NOT compiled in this
// environment (Tauri Linux build deps — webkit2gtk — are absent). It is a
// faithful translation; build + `cargo test` before shipping.
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

use crate::magi_config::{merge_provider, ProviderSpec};

#[derive(Default)]
pub struct RuntimeState {
    child: Mutex<Option<CommandChild>>,
    url: Mutex<Option<String>>,
    port: Mutex<Option<u16>>,
}

/// App-private runtime root, e.g. ~/Library/Application Support/com.ai4s.workbench/runtime
fn runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("runtime"))
}

/// App-private Magi state root ($MAGI_CONFIG_DIR). Holds config.yaml, the
/// session sqlite, skills, devices and the daemon pairing credentials — the
/// exact layout Magi expects under ~/.magi-next.
fn magi_config_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("magi"))
}

/// File recording the user's chosen active workspace folder (absolute path).
fn active_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("active-workspace.txt"))
}

/// File recording the user's chosen BASE folder — the parent every new dated
/// session workspace is created under (Settings → Workspace).
fn base_workspace_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(runtime_root(app)?.join("base-workspace.txt"))
}

/// The active workspace folder OpenCode / the kernel / previews / provenance all
/// operate in. Defaults to the base folder (`~/Documents/OpenScience`) until the
/// user opens or creates another one; the choice persists across restarts.
pub fn workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = active_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = PathBuf::from(s.trim());
            if dir.is_dir() {
                return Ok(dir);
            }
        }
    }
    base_workspace_dir(app)
}

/// The workspace root new dated session folders are created under. A folder
/// the user picked in Settings wins; the default is `~/Documents/OpenScience`
/// (no space — the agent runs shell commands against this path, and unquoted
/// spaces break them), falling back to `$HOME/Documents`.
pub fn base_workspace_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(f) = base_workspace_file(app) {
        if let Ok(s) = std::fs::read_to_string(&f) {
            let dir = PathBuf::from(s.trim());
            if dir.is_dir() {
                return Ok(dir);
            }
        }
    }
    let docs = match app.path().document_dir() {
        Ok(d) => d,
        Err(_) => {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map_err(|_| "could not resolve a documents directory".to_string())?;
            PathBuf::from(home).join("Documents")
        }
    };
    let dir = docs.join("OpenScience");

    // One-time migrations, oldest name last. A failed rename (e.g. cross-volume)
    // keeps the existing location rather than splitting the user's files.
    if !dir.exists() {
        for old in [docs.join("Open Science"), runtime_root(app)?.join("workspace")] {
            if old.is_dir() {
                if std::fs::rename(&old, &dir).is_ok() {
                    break;
                }
                return Ok(old);
            }
        }
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// Magi's config file inside the app-private state root ($MAGI_CONFIG_DIR/config.yaml).
fn magi_config_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(magi_config_dir(app)?.join("config.yaml"))
}

/// Kept for command-surface compatibility with the frontend bridge. Magi has no
/// CLI-login file to import — providers live in config.yaml and API keys come
/// from the daemon's process environment — so this is an honest no-op.
#[tauri::command]
pub fn import_opencode_login(_app: AppHandle, _state: State<'_, RuntimeState>) -> Result<bool, String> {
    Ok(false)
}

/// Deploy the bundled skill packs (Tauri resources) into the app-private Magi
/// profile's skills dir (`$MAGI_CONFIG_DIR/skills/`), which Magi scans for
/// installed skills: `skills/` is the external ai4s-skills pack, `skills-core/`
/// the first-party skills from `runtime/skills/core`. Runs before every daemon
/// start so app upgrades refresh the packs.
fn deploy_bundled_skills(app: &AppHandle) {
    // Magi scans $MAGI_CONFIG_DIR/skills for <name>/SKILL.md (see paths.ts).
    let dst = match magi_config_dir(app) {
        Ok(cfg) => cfg.join("skills"),
        Err(_) => return,
    };
    for resource in ["skills", "skills-core"] {
        let src = match app
            .path()
            .resolve(resource, tauri::path::BaseDirectory::Resource)
        {
            Ok(p) if p.is_dir() => p,
            _ => continue, // dev run without `fetch-skills.sh` — nothing to deploy
        };
        if let Err(e) = sync_skill_pack(&src, &dst) {
            eprintln!("failed to deploy bundled skills ({resource}): {e}");
        }
    }
}

/// Copy every skill directory under `src` into `dst`, replacing same-named
/// directories (so bundled updates win) and leaving everything else in `dst`
/// alone (user-installed skills keep their own directories). Directories
/// without a SKILL.md (placeholders) are skipped.
fn sync_skill_pack(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.path().join("SKILL.md").is_file() {
            continue;
        }
        let target = dst.join(entry.file_name());
        if target.exists() {
            std::fs::remove_dir_all(&target)?;
        }
        copy_dir(&entry.path(), &target)?;
    }
    Ok(())
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let to = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &to)?;
        } else {
            std::fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// PATH for the sidecar (and everything the agent runs through it). Apps
/// launched from Finder/Dock get a minimal PATH (`/usr/bin:/bin:…`), so the
/// agent would not find the user's Python/conda/Homebrew tools. Prepend the
/// well-known scientific tool locations that actually exist on this machine —
/// the same order a terminal profile would produce.
#[cfg(unix)]
pub(crate) fn enriched_path() -> String {
    let base = std::env::var("PATH").unwrap_or_default();
    let home = std::env::var("HOME").unwrap_or_default();
    let extras = [
        format!("{home}/anaconda3/bin"),
        format!("{home}/miniconda3/bin"),
        "/opt/anaconda3/bin".to_string(),
        "/opt/miniconda3/bin".to_string(),
        format!("{home}/.pyenv/shims"),
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        format!("{home}/.local/bin"),
    ];
    let mut parts: Vec<String> = extras
        .into_iter()
        .filter(|p| !base.split(':').any(|b| b == p) && std::path::Path::new(p).is_dir())
        .collect();
    if !base.is_empty() {
        parts.push(base);
    }
    parts.join(":")
}

pub(crate) fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(43917)
}

fn spawn_sidecar(app: &AppHandle, port: u16) -> Result<CommandChild, String> {
    let cfg = magi_config_dir(app)?;
    // Run the daemon inside the user-facing workspace, NOT the app's cwd (which
    // is `/` when launched from Finder) — control jobs default to the daemon's
    // cwd, and `control.defaultCwd` is set to this so dated subfolders validate.
    let workspace = workspace_dir(app)?;
    std::fs::create_dir_all(&cfg).map_err(|e| e.to_string())?;
    // Ship the bundled scientific skills into the app-private Magi profile.
    deploy_bundled_skills(app);
    let home = std::env::var("HOME").unwrap_or_default();
    let port_str = port.to_string();

    // `magi serve` daemonizes when MAGI_DAEMON=1 (it self-mints a long-lived
    // pairing token into $MAGI_CONFIG_DIR/state/daemon/control-credentials.json);
    // MagiClient also pairs itself over loopback, so either path authenticates.
    let cmd = app
        .shell()
        .sidecar("magi")
        .map_err(|e| format!("sidecar not found: {e}"))?
        .args(["serve"])
        // App-private state root: the daemon never touches the user's ~/.magi-next.
        .env("MAGI_CONFIG_DIR", cfg.to_string_lossy().to_string())
        .env("MAGI_CONTROL_BIND", "127.0.0.1")
        .env("MAGI_CONTROL_PORT", port_str.as_str())
        .env("MAGI_DAEMON", "1")
        // No LAN discovery for a local desktop daemon.
        .env("MAGI_DISABLE_MDNS", "1")
        // Give the user time to answer an approval/question before it times out
        // (Magi's default is 300 s; a research turn may pause much longer).
        .env("MAGI_INTERACTION_TIMEOUT_MS", "1800000")
        .env("HOME", home)
        .current_dir(workspace);
    // GUI-launched apps get a minimal PATH; give the agent the user's real tools.
    #[cfg(unix)]
    let cmd = cmd.env("PATH", enriched_path());

    let (mut rx, child) = cmd.spawn().map_err(|e| format!("failed to spawn magi: {e}"))?;
    // Drain events so the child's stdout/stderr buffer never blocks it.
    tauri::async_runtime::spawn(async move { while rx.recv().await.is_some() {} });
    Ok(child)
}

/// Start the bundled OpenCode (idempotent). Returns its base URL.
#[tauri::command]
pub fn start_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<String, String> {
    if let Some(url) = state.url.lock().unwrap().clone() {
        return Ok(url);
    }
    // Reuse a stable port across restarts so the frontend URL doesn't change.
    let port = {
        let mut p = state.port.lock().unwrap();
        *p.get_or_insert_with(free_port)
    };
    let child = spawn_sidecar(&app, port)?;
    let url = format!("http://127.0.0.1:{port}");
    *state.child.lock().unwrap() = Some(child);
    *state.url.lock().unwrap() = Some(url.clone());
    Ok(url)
}

/// The workspace directory the sidecar runs in — the frontend passes it to the
/// SDK so skill discovery is scoped to the right OpenCode instance.
#[tauri::command]
pub fn workspace_path(app: AppHandle) -> Result<String, String> {
    Ok(workspace_dir(&app)?.to_string_lossy().to_string())
}

/// The base folder new dated workspaces are created under (`~/Documents/OpenScience`).
#[tauri::command]
pub fn workspace_base(app: AppHandle) -> Result<String, String> {
    Ok(base_workspace_dir(&app)?.to_string_lossy().to_string())
}

/// Choose the base folder (Settings → Workspace → Change). Creates it if
/// needed and persists the choice; every NEW session's dated folder is created
/// under it. Existing sessions keep their folders.
#[tauri::command]
pub fn set_workspace_base(app: AppHandle, path: String) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("workspace base must be absolute".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(base_workspace_file(&app)?, canon.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;
    Ok(canon.to_string_lossy().to_string())
}

/// Reveal the base workspace folder in the OS file manager. (The sandboxed
/// `open_path` resolves inside the ACTIVE workspace only, which may be a dated
/// subfolder — the base needs its own door.)
#[tauri::command]
pub fn open_workspace_base(app: AppHandle) -> Result<(), String> {
    crate::artifact_file::os_open(&base_workspace_dir(&app)?)
}

/// Switch the active workspace folder: create it if needed and persist the
/// choice. The kernel / Files / provenance read the folder via `workspace_dir`;
/// the agent runtime is scoped per request — the frontend reconnects its event
/// stream with `?directory=` and creates sessions with it (a bare `/event`
/// stream would not see other folders' instances, so the scoped stream is
/// required). `path` must be absolute.
#[tauri::command]
pub fn set_workspace(
    app: AppHandle,
    _state: State<'_, RuntimeState>,
    path: String,
) -> Result<String, String> {
    let dir = PathBuf::from(&path);
    if !dir.is_absolute() {
        return Err("workspace path must be absolute".into());
    }
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create folder: {e}"))?;
    let canon = dir.canonicalize().map_err(|e| e.to_string())?;
    std::fs::write(active_workspace_file(&app)?, canon.to_string_lossy().as_bytes())
        .map_err(|e| e.to_string())?;

    // No sidecar restart: OpenCode serves every folder from one process via
    // per-directory instances, and the frontend reconnects its event stream
    // with `?directory=<new folder>`. Restarting here used to cost 3-6 s per
    // history-session switch (process boot + reconnect polling).
    // Jupyter-lab, however, pins its root_dir at spawn time — re-root it (in
    // the background) so agent-created notebooks land in the new folder.
    crate::jupyter::reroot_jupyter(&app);
    Ok(canon.to_string_lossy().to_string())
}

/// Create a new dated folder `<base>/<name>` and switch to it. `name` is a
/// single path segment (the frontend supplies a timestamp); rejects separators.
#[tauri::command]
pub fn new_dated_workspace(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    name: String,
) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("invalid folder name".into());
    }
    let dir = base_workspace_dir(&app)?.join(&name);
    set_workspace(app, state, dir.to_string_lossy().to_string())
}

/// Native "choose a folder" dialog; returns the absolute path, or None on cancel.
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let Some(picked) = app.dialog().file().blocking_pick_folder() else {
        return Ok(None);
    };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

/// Kill the bundled OpenCode if running.
#[tauri::command]
pub fn stop_runtime(state: State<'_, RuntimeState>) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
    *state.url.lock().unwrap() = None;
}

pub fn kill_child(state: &RuntimeState) {
    if let Some(child) = state.child.lock().unwrap().take() {
        let _ = child.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::sync_skill_pack;
    use std::fs;

    fn write(path: &std::path::Path, content: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn sync_replaces_bundled_and_keeps_user_skills() {
        let tmp = std::env::temp_dir().join(format!("skillsync-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        let dst = tmp.join("dst");

        // Bundled pack: one skill with a nested reference file, plus a top-level
        // plain file (.commit) that must NOT be copied.
        write(&src.join("paper-writer/SKILL.md"), "v2");
        write(&src.join("paper-writer/references/guide.md"), "ref");
        write(&src.join(".commit"), "abc123");
        // A placeholder dir without SKILL.md must not be deployed.
        fs::create_dir_all(src.join("placeholder")).unwrap();

        // Existing workspace: a stale copy of the bundled skill (with a file the
        // new version no longer has) and a user-installed skill.
        write(&dst.join("paper-writer/SKILL.md"), "v1");
        write(&dst.join("paper-writer/obsolete.md"), "old");
        write(&dst.join("my-skill/SKILL.md"), "user");

        sync_skill_pack(&src, &dst).unwrap();

        assert_eq!(fs::read_to_string(dst.join("paper-writer/SKILL.md")).unwrap(), "v2");
        assert_eq!(
            fs::read_to_string(dst.join("paper-writer/references/guide.md")).unwrap(),
            "ref"
        );
        assert!(!dst.join("paper-writer/obsolete.md").exists(), "stale file must be gone");
        assert_eq!(fs::read_to_string(dst.join("my-skill/SKILL.md")).unwrap(), "user");
        assert!(!dst.join(".commit").exists(), "top-level files are not skills");
        assert!(!dst.join("placeholder").exists(), "dirs without SKILL.md are not skills");

        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn sync_creates_destination_when_missing() {
        let tmp = std::env::temp_dir().join(format!("skillsync-new-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        write(&src.join("literature-survey/SKILL.md"), "s");

        let dst = tmp.join("deep/nested/skills");
        sync_skill_pack(&src, &dst).unwrap();
        assert_eq!(
            fs::read_to_string(dst.join("literature-survey/SKILL.md")).unwrap(),
            "s"
        );
        fs::remove_dir_all(&tmp).unwrap();
    }
}

/// Removing a provider/MCP entry means editing config.yaml. Magi's YAML is
/// hand-authored (comments, anchors, ordering the user cares about), so v0.1
/// does not rewrite it programmatically — the user edits config.yaml and
/// reconnects. Kept for command-surface compatibility; returns a clear error.
#[tauri::command]
pub fn remove_config_entry(
    _app: AppHandle,
    _state: State<'_, RuntimeState>,
    section: String,
    key: String,
) -> Result<(), String> {
    Err(format!(
        "Editing config.yaml is manual in this version — remove {section}.{key} in $MAGI_CONFIG_DIR/config.yaml and reconnect."
    ))
}

/// Write a provider block + `main` alias into the app-private config.yaml and
/// restart the daemon so it reloads. The API KEY is never written to the file
/// (Magi reads it from the daemon's environment via `apiKeyEnv`); the desktop
/// shell is responsible for putting the key in the spawn env from the OS
/// keychain — see the safety guardrails. Returns the base URL (stable port).
#[tauri::command]
pub fn configure_opencode(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    provider: String,
    api_key: String,
    model: String,
    base_url: Option<String>,
) -> Result<String, String> {
    let _ = api_key; // never persisted to config.yaml (keychain → spawn env, future)
    let base = base_url.unwrap_or_default();
    // Anthropic-shaped endpoints speak the messages format; everything else is
    // treated as OpenAI-chat compatible (the common case for local/hosted).
    let format = if provider == "anthropic" {
        "anthropic-messages"
    } else {
        "openai-chat"
    };
    let env_name = format!("{}_API_KEY", provider.to_uppercase());
    let spec = ProviderSpec {
        name: &provider,
        kind: "messages-compatible",
        format,
        base_url: &base,
        default_model: &model,
        api_key_env: &env_name,
    };
    let path = magi_config_file(&app)?;
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let merged = merge_provider(&existing, &spec, !model.is_empty());
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, merged).map_err(|e| e.to_string())?;

    // Restart so the running daemon reloads the new provider config.
    let was_running = state.url.lock().unwrap().is_some();
    if was_running {
        kill_child(&state);
        let port = { *state.port.lock().unwrap().get_or_insert_with(free_port) };
        let child = spawn_sidecar(&app, port)?;
        *state.child.lock().unwrap() = Some(child);
        let url = format!("http://127.0.0.1:{port}");
        *state.url.lock().unwrap() = Some(url.clone());
        Ok(url)
    } else {
        Ok(path.to_string_lossy().to_string())
    }
}
