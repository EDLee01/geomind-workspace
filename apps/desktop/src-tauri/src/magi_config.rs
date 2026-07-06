// Pure merge of provider credentials/model into Magi's config.yaml.
// Magi reads YAML at $MAGI_CONFIG_DIR/config.yaml (providers, models.aliases,
// mcp.servers). There is NO Control-API route to write config — the desktop
// shell owns config.yaml and restarts the daemon after a change. This module
// is intentionally dependency-free: it edits the small, known subset of the
// file the app manages, preserving everything else line-for-line.
//
// NOTE: this file is part of the OpenCode→Magi runtime migration and has not
// been compiled in this environment (the Tauri Linux build deps — webkit2gtk —
// are not installed here). It is a faithful translation of the prior
// opencode_config.rs pattern; build + `cargo test` before shipping.

/// A provider entry the app knows how to write into `providers:`.
pub struct ProviderSpec<'a> {
    pub name: &'a str,
    /// Magi provider type, e.g. "messages-compatible".
    pub kind: &'a str,
    /// Wire format, e.g. "anthropic-messages" or "openai-chat".
    pub format: &'a str,
    pub base_url: &'a str,
    pub default_model: &'a str,
    /// Env var name the daemon reads the key from (the KEY itself never goes
    /// into config.yaml — it is passed to the daemon process environment).
    pub api_key_env: &'a str,
}

/// Merge/replace a provider block and the `main` alias in Magi config YAML.
/// Empty existing input yields a minimal valid document. Existing content is
/// preserved except the managed `providers.<name>` block and `models.aliases.main`.
///
/// Kept deliberately simple: it operates on the documented flat structure the
/// app writes, not arbitrary YAML. For anything richer the user edits the file.
pub fn merge_provider(existing: &str, spec: &ProviderSpec, set_main_alias: bool) -> String {
    let mut doc = if existing.trim().is_empty() {
        "version: \"1\"\n".to_string()
    } else {
        existing.to_string()
    };
    if !doc.ends_with('\n') {
        doc.push('\n');
    }

    let block = render_provider_block(spec);
    // Replace an existing block for this provider, or append a providers section.
    if let Some(range) = provider_block_range(&doc, spec.name) {
        doc.replace_range(range, &block);
    } else if let Some(idx) = doc.find("\nproviders:\n").map(|i| i + "\nproviders:\n".len()) {
        doc.insert_str(idx, &block);
    } else {
        doc.push_str("providers:\n");
        doc.push_str(&block);
    }

    if set_main_alias {
        doc = set_alias(&doc, "main", &format!("{}/{}", spec.name, spec.default_model));
    }
    doc
}

fn render_provider_block(spec: &ProviderSpec) -> String {
    format!(
        "  {name}:\n    type: {kind}\n    format: {format}\n    apiKeyEnv: {env}\n    baseUrl: {url}\n    defaultModel: {model}\n",
        name = spec.name,
        kind = spec.kind,
        format = spec.format,
        env = spec.api_key_env,
        url = spec.base_url,
        model = spec.default_model,
    )
}

/// The byte range of a `providers.<name>:` block (its header line through the
/// last of its indented children), or None if absent.
fn provider_block_range(doc: &str, name: &str) -> Option<std::ops::Range<usize>> {
    let header = format!("  {name}:\n");
    let start = doc.find(&header)?;
    let after = start + header.len();
    // Children are indented deeper than 2 spaces; the block ends at the first
    // subsequent line indented <= 2 spaces (a sibling provider or new section).
    let mut end = doc.len();
    let mut cursor = after;
    for line in doc[after..].split_inclusive('\n') {
        let indent = line.len() - line.trim_start().len();
        let blank = line.trim().is_empty();
        if !blank && indent <= 2 {
            end = cursor;
            break;
        }
        cursor += line.len();
    }
    Some(start..end)
}

/// Set `models.aliases.<alias>: <target>`, creating the section/keys if needed.
fn set_alias(doc: &str, alias: &str, target: &str) -> String {
    let line = format!("    {alias}: {target}\n");
    // Already present under models.aliases → replace that line.
    if let Some(pos) = find_alias_line(doc, alias) {
        let mut out = doc.to_string();
        out.replace_range(pos.clone(), &line);
        return out;
    }
    let mut out = doc.to_string();
    if let Some(idx) = out.find("\n  aliases:\n").map(|i| i + "\n  aliases:\n".len()) {
        out.insert_str(idx, &line);
    } else if let Some(idx) = out.find("\nmodels:\n").map(|i| i + "\nmodels:\n".len()) {
        out.insert_str(idx, &format!("  aliases:\n{line}"));
    } else {
        if !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str(&format!("models:\n  aliases:\n{line}"));
    }
    out
}

fn find_alias_line(doc: &str, alias: &str) -> Option<std::ops::Range<usize>> {
    let needle = format!("    {alias}: ");
    let mut cursor = 0usize;
    for line in doc.split_inclusive('\n') {
        if line.starts_with(&needle) {
            return Some(cursor..cursor + line.len());
        }
        cursor += line.len();
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn anthropic() -> ProviderSpec<'static> {
        ProviderSpec {
            name: "anthropic",
            kind: "messages-compatible",
            format: "anthropic-messages",
            base_url: "https://api.anthropic.com",
            default_model: "claude-sonnet-4-6",
            api_key_env: "ANTHROPIC_API_KEY",
        }
    }

    #[test]
    fn writes_provider_and_main_alias_into_empty_config() {
        let out = merge_provider("", &anthropic(), true);
        assert!(out.contains("providers:\n  anthropic:\n"));
        assert!(out.contains("apiKeyEnv: ANTHROPIC_API_KEY"));
        assert!(out.contains("main: anthropic/claude-sonnet-4-6"));
        // The key value itself is never written to the file.
        assert!(!out.contains("sk-"));
    }

    #[test]
    fn replaces_an_existing_provider_block_and_keeps_others() {
        let existing = "version: \"1\"\nproviders:\n  anthropic:\n    type: old\n    baseUrl: old\n  siliconflow:\n    type: messages-compatible\n    defaultModel: deepseek\n";
        let out = merge_provider(existing, &anthropic(), false);
        assert!(out.contains("type: messages-compatible"));
        assert!(!out.contains("type: old"));
        assert!(out.contains("siliconflow:"), "sibling provider preserved");
        assert!(out.contains("defaultModel: deepseek"));
    }

    #[test]
    fn updates_an_existing_main_alias_in_place() {
        let existing = "version: \"1\"\nmodels:\n  aliases:\n    main: old/model\n    fast: x/y\n";
        let out = merge_provider(existing, &anthropic(), true);
        assert!(out.contains("main: anthropic/claude-sonnet-4-6"));
        assert!(!out.contains("main: old/model"));
        assert!(out.contains("fast: x/y"), "other aliases preserved");
    }
}
