import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, History, Loader2, NotebookPen, Play, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { NotebookCell } from "@ai4s/shared";
import { readArtifact, writeWorkspaceFile } from "@/lib/artifactFile";
import { ProvenancePanel } from "@/components/inspector/ProvenancePanel";
import { parseIpynb, serializeIpynb, notebookLanguage } from "@/lib/notebook-file";
import {
  formatExecResult,
  isCodeLanguage,
  kernelExecute,
  type KernelLanguage,
} from "@/lib/kernel";
import { toast } from "@/lib/toast";
import { useScrollMemory } from "@/lib/scrollMemory";
import { cn } from "@/lib/cn";

/**
 * Runnable editor for a real workspace .ipynb. Used full-page (Notebooks page)
 * and as the right-pane inspector next to a conversation — the agent edits the
 * same file, so Reload picks up its changes.
 */
export function NotebookEditor({
  path,
  root,
  onBack,
  onClose,
}: {
  path: string;
  /** Folder tree `path` resolves in (default the active workspace). The
   *  kernel also runs with the notebook's own folder as cwd. */
  root?: "workspace" | "base";
  /** Back navigation (full-page use). */
  onBack?: () => void;
  /** Close the pane (inspector use). */
  onClose?: () => void;
}) {
  const [cells, setCells] = useState<NotebookCell[] | null>(null);
  const [language, setLanguage] = useState<KernelLanguage>("python");
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState<number | null>(null);
  const [saved, setSaved] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const cellsRef = useRef<NotebookCell[] | null>(null);
  cellsRef.current = cells;
  const rawRef = useRef<string | null>(null);
  const savedRef = useRef(true);
  savedRef.current = saved;

  const load = useCallback(async () => {
    setError(null);
    try {
      const f = await readArtifact(path, root);
      if (!f || f.encoding !== "utf8") throw new Error("could not read the notebook");
      rawRef.current = f.data;
      setLanguage(notebookLanguage(f.data));
      setCells(parseIpynb(f.data));
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [path, root]);

  useEffect(() => {
    void load();
  }, [load]);

  // Follow the agent live: while the user isn't mid-edit, poll the file and
  // reload when its content changed on disk (the agent writes via Jupyter).
  useEffect(() => {
    const t = setInterval(() => {
      if (!savedRef.current) return; // never clobber unsaved local edits
      void (async () => {
        try {
          const f = await readArtifact(path, root);
          if (f && f.encoding === "utf8" && rawRef.current !== null && f.data !== rawRef.current) {
            rawRef.current = f.data;
            setLanguage(notebookLanguage(f.data));
            setCells(parseIpynb(f.data));
          }
        } catch {
          /* transient read failures are fine */
        }
      })();
    }, 2000);
    return () => clearInterval(t);
  }, [path, root]);

  const save = useCallback(async () => {
    const current = cellsRef.current;
    if (!current) return;
    try {
      const out = serializeIpynb(current);
      await writeWorkspaceFile(path, out, root);
      rawRef.current = out; // our own write is not an external change
      setSaved(true);
    } catch (e) {
      toast.error(`Could not save: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [path, root]);

  // Debounced autosave: runs AFTER React commits the latest cells, so the file
  // always gets the freshest state (saving inside handlers would race setState).
  useEffect(() => {
    if (saved || !cells) return;
    const t = setTimeout(() => void save(), 500);
    return () => clearTimeout(t);
  }, [cells, saved, save]);

  const update = (index: number, patch: Partial<NotebookCell>) => {
    setCells((c) => c?.map((cell) => (cell.index === index ? { ...cell, ...patch } : cell)) ?? null);
    setSaved(false);
  };

  const run = async (cell: NotebookCell) => {
    if (running !== null) return;
    setRunning(cell.index);
    update(cell.index, { output: "running…" });
    try {
      const lang = isCodeLanguage(cell.language) ? cell.language : language;
      const res = await kernelExecute(cell.code, lang, path, root);
      update(cell.index, {
        output: res ? formatExecResult(res) : "(local kernel available only in the desktop app)",
      });
    } catch (e) {
      update(cell.index, { output: `kernel error: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setRunning(null);
    }
  };

  const addCell = () => {
    setCells((c) => {
      const next = (c?.[c.length - 1]?.index ?? 0) + 1;
      return [...(c ?? []), { index: next, language, code: "" }];
    });
    setSaved(false);
  };

  const removeCell = (index: number) => {
    setCells((c) => c?.filter((cell) => cell.index !== index) ?? null);
    setSaved(false);
  };

  // Where the user was in this notebook, restored when they come back to it
  // (session switch, pane reopen) — once the cells are in, so the offset holds.
  const scrollRef = useRef<HTMLDivElement>(null);
  const onScroll = useScrollMemory(scrollRef, `file:${path}`, cells !== null);

  const onCellKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>, cell: NotebookCell) => {
    if ((e.metaKey || e.ctrlKey || e.shiftKey) && e.key === "Enter") {
      e.preventDefault();
      void run(cell);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        {onBack && (
          <button className="text-muted hover:text-text" aria-label="Back to notebooks" onClick={onBack}>
            <ArrowLeft size={15} />
          </button>
        )}
        <NotebookPen size={14} className="shrink-0 text-muted" />
        <h1 className="truncate text-[13px] font-medium text-text">{path}</h1>
        <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
          {language === "r" ? "R" : "Python"}
        </span>
        <span className="shrink-0 text-xs text-muted">{saved ? "Saved" : "Unsaved"}</span>
        <div className="flex-1" />
        <span className="hidden shrink-0 text-xs text-muted xl:inline">
          Shift/⌘+Enter runs a cell · shared with the agent
        </span>
        <button
          className={cn(showHistory ? "text-text" : "text-muted hover:text-text")}
          aria-label="History"
          title="History — every recorded version with its code and conversation"
          aria-pressed={showHistory}
          onClick={() => setShowHistory((v) => !v)}
        >
          <History size={14} />
        </button>
        <button
          className="text-muted hover:text-text"
          aria-label="Reload from disk"
          title="Reload (pick up the agent's changes)"
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
        {onClose && (
          <button className="text-muted hover:text-text" aria-label="Close inspector" onClick={onClose}>
            <X size={16} />
          </button>
        )}
      </div>

      {showHistory && (
        <div className="flex-1 overflow-y-auto bg-surface-2">
          <ProvenancePanel path={path} language={language} />
        </div>
      )}
      <div ref={scrollRef} onScroll={onScroll} className={cn("flex-1 overflow-y-auto", showHistory && "hidden")}>
        <div className="mx-auto max-w-3xl px-6 py-5">
          {error && <div className="text-sm text-error">{error}</div>}
          {!error && !cells && (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="animate-spin" /> Loading…
            </div>
          )}
          {cells?.map((cell) => (
            <div key={cell.index} className="group mb-4">
              <div className="mb-1 flex items-center gap-2 text-xs text-muted">
                <span className="font-mono">[{cell.index}]</span>
                <span>{cell.language}</span>
                {isCodeLanguage(cell.language) && (
                  <button
                    className="hidden items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-surface-2 hover:text-text group-hover:flex"
                    aria-label={`Run cell ${cell.index}`}
                    onClick={() => void run(cell)}
                    disabled={running !== null}
                  >
                    {running === cell.index ? (
                      <Loader2 size={11} className="animate-spin" />
                    ) : (
                      <Play size={11} />
                    )}
                    Run
                  </button>
                )}
                <button
                  className="hidden rounded px-1 py-0.5 hover:bg-surface-2 hover:text-error group-hover:block"
                  aria-label={`Delete cell ${cell.index}`}
                  onClick={() => removeCell(cell.index)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
              <textarea
                value={cell.code}
                onChange={(e) => update(cell.index, { code: e.target.value })}
                onKeyDown={(e) => onCellKeyDown(e, cell)}
                rows={Math.min(Math.max(cell.code.split("\n").length, 1), 14)}
                spellCheck={false}
                className={cn(
                  "w-full resize-none rounded-input border border-border bg-surface p-3 font-mono text-[12.5px] leading-relaxed text-text outline-none focus:border-accent/50",
                  !isCodeLanguage(cell.language) && "bg-surface-2 text-muted",
                )}
                aria-label={`Cell ${cell.index}`}
              />
              {cell.output && (
                <pre className="mt-1.5 whitespace-pre-wrap rounded-input border border-border bg-surface-2 p-3 font-mono text-[12px] text-text">
                  {cell.output}
                </pre>
              )}
              {cell.image && (
                <img
                  src={`data:image/png;base64,${cell.image}`}
                  alt={`Cell ${cell.index} figure`}
                  className="mt-1.5 max-w-full rounded-input border border-border bg-white p-2"
                />
              )}
            </div>
          ))}
          {cells && (
            <button
              className="flex items-center gap-1.5 rounded-input border border-dashed border-border px-3 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-text"
              onClick={addCell}
            >
              <Plus size={12} /> Add cell
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
