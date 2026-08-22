import { useMemo, useState } from "react";
import type { CrossInfraMap, IdentityLink } from "@crystal/core";
import { Button, Dialog, DialogClose, DialogContent, Input } from "@crystal/ui";

const memberId = (member: IdentityLink["members"][number]) => `${member.ws}\0${member.key}`;

export function LinkServicesDialog({
  open,
  map,
  initialMembers,
  initialLabel,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  map: CrossInfraMap;
  initialMembers: IdentityLink["members"];
  initialLabel?: string;
  onOpenChange: (open: boolean) => void;
  onConfirm: (members: IdentityLink["members"], label?: string) => void;
}) {
  const [checked, setChecked] = useState(() => new Set(initialMembers.map(memberId)));
  const [label, setLabel] = useState(() => initialLabel ?? "");
  const projects = useMemo(() => [...map.projects]
    .sort((a, b) => a.name.localeCompare(b.name) || a.ws.localeCompare(b.ws))
    .map((project) => {
      const byKey = new Map<string, { key: string; label: string }>();
      for (const env of project.environments) {
        for (const external of env.externals) if (!byKey.has(external.id)) byKey.set(external.id, { key: external.id, label: external.label });
      }
      return { ...project, externals: [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key)) };
    }), [map]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Link detected services" description="Assert that selected services are the same logical instance.">
        <label className="mb-3 block text-[11px] text-ink-muted">
          <span className="mb-1 block">Shared label (optional)</span>
          <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Most common service label" />
        </label>
        <div className="max-h-64 space-y-3 overflow-y-auto rounded-lg border border-edge bg-surface-1 p-2">
          {projects.map((project) => (
            <section key={project.ws}>
              <div className="mb-1 text-[10px] font-semibold text-ink-muted">{project.name}</div>
              {project.externals.length ? project.externals.map((external) => {
                const member = { ws: project.ws, key: external.key };
                const id = memberId(member);
                return (
                  <label key={external.key} className="flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-[11px] hover:bg-surface-2">
                    <input
                      type="checkbox"
                      checked={checked.has(id)}
                      onChange={(event) => setChecked((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(id); else next.delete(id);
                        return next;
                      })}
                      className="mt-0.5 accent-crystal-500"
                    />
                    <span className="min-w-0"><span className="block truncate text-ink">{external.label}</span><span className="block truncate text-[9px] text-ink-faint">{external.key}</span></span>
                  </label>
                );
              }) : <div className="px-1.5 text-[10px] text-ink-faint">No detected externals</div>}
            </section>
          ))}
        </div>
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-[10px] text-ink-faint">Select at least two services.</span>
          <div className="flex gap-2">
            <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
            <Button
              variant="primary"
              size="sm"
              disabled={checked.size < 2}
              onClick={() => {
                const members = [...checked].sort().map((id) => {
                  const [ws, key] = id.split("\0");
                  return { ws: ws!, key: key! };
                });
                onConfirm(members, label.trim() || undefined);
                onOpenChange(false);
              }}
            >Link services</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
