import { Dialog, DialogContent, Kbd } from "@crystal/ui";
import { shortcutCheatSheetGroups } from "./shortcuts.js";

export function KeyboardShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const groups = shortcutCheatSheetGroups();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Keyboard shortcuts" className="top-[45%] w-[520px]">
        <div className="grid max-h-[65vh] grid-cols-2 gap-5 overflow-y-auto">
          {groups.map((group) => (
            <section key={group.label}>
              <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {group.label}
              </h3>
              <div className="divide-y divide-edge rounded-lg border border-edge bg-surface-1 px-2.5">
                {group.rows.map((row) => (
                  <div key={row.id} className="flex items-center gap-3 py-1.5 text-xs">
                    <span className="min-w-0 flex-1 truncate text-ink-muted">{row.label}</span>
                    <Kbd className="h-auto min-h-5 shrink-0">{row.hint}</Kbd>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
