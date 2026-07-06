import type { ModelStatus, RuntimeStatus } from "@ai4s/shared";
import { useRuntimeStore } from "@/lib/runtime";
import { cn } from "@/lib/cn";

const RUNTIME_TONE: Record<RuntimeStatus, string> = {
  ready: "bg-ok",
  connecting: "bg-warn",
  error: "bg-error",
  offline: "bg-muted",
};

const MODEL_TONE: Record<ModelStatus, string> = {
  connected: "bg-ok",
  disconnected: "bg-muted",
  error: "bg-error",
};

export function StatusPills() {
  // Both live from the runtime: connection status + the active model alias
  // (Magi resolves the alias to a concrete provider/model server-side).
  const runtime = useRuntimeStore((s) => s.status);
  const modelAlias = useRuntimeStore((s) => s.model);
  const connected = useRuntimeStore((s) => s.status === "ready");
  const model: ModelStatus = connected ? "connected" : "disconnected";

  return (
    <div className="flex flex-col gap-1 text-xs text-muted">
      <Pill dot={RUNTIME_TONE[runtime]} label="Runtime" value={runtime} />
      <Pill dot={MODEL_TONE[model]} label="Model" value={modelAlias || "not set"} />
    </div>
  );
}

function Pill({ dot, label, value }: { dot: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-2">
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
      <span className="shrink-0">{label}</span>
      <span className="ml-auto min-w-0 truncate capitalize text-text/70" title={value}>
        {value}
      </span>
    </div>
  );
}
