import type { Inspector } from "@ai4s/shared";
import { ArtifactInspector } from "./ArtifactInspector";
import { NotebookInspector } from "./NotebookInspector";
import { PdfInspector } from "./PdfInspector";
import { FilePreviewInspector } from "./FilePreviewInspector";
import { NotebookEditor } from "@/components/notebook/NotebookEditor";

/** Right pane. Renders the correct inspector variant for the active session. */
export function InspectorShell({
  inspector,
  onClose,
  onEvaluate,
}: {
  inspector: Inspector;
  onClose: () => void;
  /** Forward notebook expressions to the agent's live kernel (live session only). */
  onEvaluate?: (expr: string) => void;
}) {
  return (
    <div className="h-full border-l border-border bg-surface" data-variant={inspector.variant}>
      {inspector.variant === "artifact" && <ArtifactInspector data={inspector} onClose={onClose} />}
      {inspector.variant === "notebook" && (
        <NotebookInspector data={inspector} onClose={onClose} onEvaluate={onEvaluate} />
      )}
      {inspector.variant === "pdf" && <PdfInspector data={inspector} onClose={onClose} />}
      {inspector.variant === "file" && <FilePreviewInspector data={inspector} onClose={onClose} />}
      {inspector.variant === "notebook-file" && (
        <NotebookEditor path={inspector.path} root={inspector.root} onClose={onClose} />
      )}
    </div>
  );
}
