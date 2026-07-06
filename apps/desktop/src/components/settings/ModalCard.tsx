import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { isTauri, modalStatus, type ModalStatus } from "@/lib/tauri";
import { cn } from "@/lib/cn";

/**
 * Cloud compute (Modal) status (P2-2). Like the HPC card, the app never handles
 * credentials — Modal runs use the user's own install + token. This card only
 * detects readiness; the bundled `modal-run` skill drives actual jobs.
 */
export function ModalCard() {
  const [status, setStatus] = useState<ModalStatus | null>(null);
  const [checking, setChecking] = useState(false);

  const check = useCallback(async () => {
    if (!isTauri) return;
    setChecking(true);
    try {
      setStatus(await modalStatus());
    } catch {
      setStatus(null);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const ok = status?.installed && status?.authenticated;
  const dot = ok ? "bg-ok" : status?.installed ? "bg-warn" : "bg-muted";

  return (
    <section className="mt-5 rounded-card border border-border bg-surface shadow-card">
      <header className="flex items-center gap-2 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-serif text-[15px] text-text">Cloud compute (Modal)</h2>
          <p className="mt-0.5 text-xs text-muted">
            Run GPU / elastic jobs on Modal with your own account — then just ask the agent.
          </p>
        </div>
        {isTauri && (
          <button
            className="inline-flex items-center gap-1 rounded-input border border-border px-2 py-1 text-[12px] text-muted hover:text-text"
            onClick={() => void check()}
            disabled={checking}
            title="Re-check"
          >
            {checking ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} Re-check
          </button>
        )}
      </header>
      <div className="px-5 py-4 text-[13px]">
        {!isTauri ? (
          <p className="text-muted">Available in the desktop app.</p>
        ) : (
          <div className="flex items-start gap-2.5">
            <span className={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", dot)} />
            <div className="min-w-0">
              <div className="text-text">
                {ok
                  ? `Ready${status?.version ? ` · ${status.version}` : ""}`
                  : status?.installed
                    ? "Installed, not authenticated"
                    : "Not installed"}
              </div>
              {status?.hint && <div className="mt-0.5 text-xs text-muted">{status.hint}</div>}
              {ok && (
                <div className="mt-0.5 text-xs text-muted">
                  Ask the agent to run heavy work on Modal — it uses the{" "}
                  <span className="font-mono">modal-run</span> skill and your token.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
