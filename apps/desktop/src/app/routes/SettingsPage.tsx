import { useCallback, useEffect, useState } from "react";
import { ChevronDown, FolderOpen } from "lucide-react";
import type { MagiProviderInfo } from "@ai4s/sdk";
import { useUiStore } from "@/lib/store";
import { getClient, useRuntimeStore } from "@/lib/runtime";
import {
  jupyterStatus,
  openWorkspaceBase,
  pickFolder,
  setWorkspaceBase,
  workspaceBase,
  type JupyterStatus,
} from "@/lib/tauri";
import { ClusterCard } from "@/components/settings/ClusterCard";
import { ModalCard } from "@/components/settings/ModalCard";
import { DataFlowCard } from "@/components/settings/DataFlowCard";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";

/**
 * Settings for the Magi runtime. Magi's Control API is read-only for
 * configuration — providers, model aliases and MCP servers live in the
 * daemon's `config.yaml`, and there is no HTTP route to write it. So this page
 * READS the runtime's config (providers, aliases) and lets the user pick which
 * alias to run; writing config is done by the desktop shell's Rust side
 * (config.yaml + daemon restart). Provider keys, MCP servers and the science
 * connectors move there — see docs/MAGI_RUNTIME_FEASIBILITY.md.
 */
export function SettingsPage() {
  const theme = useUiStore((s) => s.theme);
  const setTheme = useUiStore((s) => s.setTheme);
  const { status, serverUrl, setServerUrl, connect, disconnect, model, modelAliases, setModel } =
    useRuntimeStore();
  const connected = status === "ready";

  const [providers, setProviders] = useState<MagiProviderInfo[]>([]);
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [jupyter, setJupyter] = useState<JupyterStatus | null>(null);
  const [wsPath, setWsPath] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const client = getClient();
    if (!client) return;
    try {
      const p = await client.listProviders();
      setProviders(p.providers);
      setAliases(p.aliases);
      setJupyter(await jupyterStatus());
    } catch {
      /* runtime not ready yet */
    }
  }, []);

  useEffect(() => {
    if (connected) void refresh();
  }, [connected, refresh]);
  useEffect(() => {
    void workspaceBase().then(setWsPath);
  }, []);

  const changeWorkspaceBase = async () => {
    const picked = await pickFolder();
    if (!picked) return;
    try {
      setWsPath(await setWorkspaceBase(picked));
      toast.success("New sessions will be created in this folder.");
    } catch (err) {
      toast.error(`Could not set the folder: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // The alias options come from config.yaml (models.aliases); fall back to the
  // conventional set so the picker is usable before the first providers fetch.
  const aliasOptions = modelAliases.length > 0 ? modelAliases : ["main", "fast", "deep", "auto"];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-8 pb-16 pt-8">
        <h1 className="font-serif text-xl text-text">Settings</h1>
        <p className="mt-0.5 text-xs text-muted">
          Runtime configuration lives in Magi&rsquo;s <span className="font-mono">config.yaml</span>;
          this page reads it and picks the model alias to run.
        </p>

        {/* ---- Agent runtime ---- */}
        <Card title="Agent runtime" hint="magi serve — Control API over HTTP + audit SSE">
          <div className="flex items-center gap-2">
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://127.0.0.1:8765"
              className={inputCls("flex-1 font-mono")}
            />
            {connected ? (
              <button onClick={disconnect} className={btnGhost()}>
                Disconnect
              </button>
            ) : (
              <button onClick={connect} className={btnAccent()}>
                Connect
              </button>
            )}
          </div>
          <div className="mt-2.5 flex items-center gap-1.5 text-xs text-muted">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full",
                connected ? "bg-ok" : status === "error" ? "bg-error" : "bg-muted",
              )}
            />
            <span className="capitalize">{status}</span>
            {connected && (
              <>
                <span className="text-border">·</span>
                <span className="font-mono">{model}</span>
              </>
            )}
          </div>
        </Card>

        {/* ---- Model alias ---- */}
        <Card title="Model" hint="Magi resolves the alias to a provider + model server-side">
          {!connected ? (
            <p className="text-[13px] text-muted">Connect the runtime to pick a model alias.</p>
          ) : (
            <>
              <div className="relative">
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  className={cn(inputCls("w-full appearance-none pr-9"), "cursor-pointer")}
                >
                  {aliasOptions.map((a) => (
                    <option key={a} value={a}>
                      {a}
                      {aliases[a] ? ` — ${aliases[a]}` : ""}
                    </option>
                  ))}
                </select>
                <ChevronDown
                  size={14}
                  className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted"
                />
              </div>

              <Divider label="Providers" />

              <div className="overflow-hidden rounded-input border border-border">
                {providers.length === 0 && (
                  <div className="bg-surface px-3 py-2.5 text-[13px] text-muted">
                    No providers configured in config.yaml.
                  </div>
                )}
                {providers.map((p, i) => (
                  <div
                    key={p.name}
                    className={cn(
                      "flex h-10 items-center gap-2.5 bg-surface px-3 text-[13px]",
                      i > 0 && "border-t border-border",
                    )}
                  >
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        p.configured ? "bg-ok" : "bg-muted",
                      )}
                    />
                    <span className="font-medium text-text">{p.name}</span>
                    <span className="text-xs text-muted">{p.type}</span>
                    <div className="flex-1" />
                    <span className="font-mono text-[11px] text-muted/70">{p.defaultModel}</span>
                    {!p.configured && (
                      <span className="ml-2 rounded-full bg-surface-2 px-2 py-0.5 text-[10px] uppercase tracking-wide text-warn ring-1 ring-border">
                        no key
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                To add a provider or set its API key, edit the daemon&rsquo;s{" "}
                <span className="font-mono">config.yaml</span> (providers + API-key env var), then
                reconnect.
              </p>
            </>
          )}
        </Card>

        {/* ---- MCP servers ---- */}
        <Card
          title="MCP servers"
          hint="Extra tools for the agent — configured in config.yaml (mcp.servers)"
        >
          <p className="text-[13px] text-muted">
            Magi loads MCP servers from <span className="font-mono">config.yaml</span>. One-click
            provisioning of the bundled science connectors and Jupyter will return once the desktop
            shell&rsquo;s config writer lands (it merges into config.yaml and restarts the daemon).
            {jupyter?.installed && " Jupyter is provisioned on this machine."}
          </p>
        </Card>

        {/* ---- Workspace ---- */}
        <Card
          title="Workspace"
          hint="Local-first — each session works in its own dated subfolder created here"
        >
          <div className="flex items-center gap-2">
            <span
              className={cn(
                inputCls("flex-1 truncate font-mono leading-9"),
                "select-all bg-surface-2 text-muted",
              )}
            >
              {wsPath ?? "available in the desktop app"}
            </span>
            {wsPath && (
              <>
                <button className={btnGhost("gap-1.5")} onClick={() => void changeWorkspaceBase()}>
                  Change…
                </button>
                <button className={btnGhost("gap-1.5")} onClick={() => void openWorkspaceBase()}>
                  <FolderOpen size={13} /> Reveal
                </button>
              </>
            )}
          </div>
        </Card>

        {/* ---- Cluster (HPC) ---- */}
        <ClusterCard />

        <ModalCard />

        {/* ---- Privacy & data flow ---- */}
        <DataFlowCard model={connected ? model : null} workspace={wsPath} />

        {/* ---- Appearance ---- */}
        <Card title="Appearance">
          <div className="inline-flex rounded-input border border-border bg-surface-2 p-0.5">
            {(["light", "dark"] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTheme(t)}
                className={cn(
                  "rounded-[5px] px-4 py-1.5 text-[13px] capitalize transition-colors",
                  theme === t ? "bg-surface text-text shadow-card" : "text-muted hover:text-text",
                )}
              >
                {t}
              </button>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

/* ---- Shared bits: one look for every control on this page ---- */

const inputCls = (extra = "") =>
  cn(
    "h-9 rounded-input border border-border bg-surface px-3 text-[13px] text-text outline-none",
    "placeholder:text-muted focus:border-accent/60",
    extra,
  );

const btnGhost = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1 rounded-input border border-border bg-surface px-3.5",
    "text-[13px] text-text transition-colors hover:bg-surface-2 disabled:opacity-50",
    extra,
  );

const btnAccent = (extra = "") =>
  cn(
    "flex h-9 shrink-0 items-center gap-1.5 rounded-input bg-accent px-3.5 text-[13px] font-medium",
    "text-accent-fg transition-opacity hover:opacity-90 disabled:opacity-50",
    extra,
  );

function Card({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="border-b border-border px-5 py-3">
        <h2 className="font-serif text-[15px] text-text">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
      </header>
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="mb-3 mt-5 flex items-center gap-3">
      <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
