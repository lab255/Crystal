import type { ArchNodeKind } from "@crystal/core";
import { Tooltip, cn } from "@crystal/ui";
import { KIND_META } from "./model.js";

export const DRAG_MIME = "application/crystal-node-kind";

const PALETTE_KINDS: ArchNodeKind[] = [
  "system",
  "group",
  "service",
  "gateway",
  "frontend",
  "datastore",
  "queue",
  "repo",
  "external",
  "note",
];

export function Palette({ onAdd }: { onAdd: (kind: ArchNodeKind) => void }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border border-edge bg-surface-2/95 p-1 shadow-xl shadow-black/30 backdrop-blur">
      {PALETTE_KINDS.map((kind) => {
        const meta = KIND_META[kind];
        const Icon = meta.icon;
        return (
          <Tooltip key={kind} content={`${meta.label} — click or drag onto canvas`} side="right">
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, kind);
                e.dataTransfer.effectAllowed = "move";
              }}
              onClick={() => onAdd(kind)}
              className={cn(
                "flex h-8 w-8 cursor-grab items-center justify-center rounded-lg text-ink-muted",
                "transition-colors hover:bg-surface-active hover:text-ink active:cursor-grabbing",
              )}
              aria-label={`Add ${meta.label}`}
            >
              <Icon className="h-4 w-4" />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
