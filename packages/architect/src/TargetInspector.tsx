import { useEffect, useState } from "react";
import { MapPin, Trash2, X } from "lucide-react";
import {
  TARGET_KINDS,
  deleteDeployTarget,
  renameDeployTarget,
  upsertDeployTarget,
  type ArchDeployTarget,
  type ArchNode,
  type ArchitectureGraph,
  type TargetKind,
} from "@crystal/core";
import { Button, Dialog, DialogClose, DialogContent, Input } from "@crystal/ui";

export function TargetInspector({ target, members, envId, graph, onChange, onSelectMember, onClose }: {
  target: ArchDeployTarget;
  members: readonly ArchNode[];
  envId: string;
  graph: ArchitectureGraph;
  onChange: (graph: ArchitectureGraph) => void;
  onSelectMember: (nodeId: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(target);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setDraft(target), [target]);

  const patch = (next: ArchDeployTarget) => {
    setDraft(next);
    onChange(next.name !== target.name
      ? upsertDeployTarget(renameDeployTarget(graph, envId, target.id, next.name), envId, next)
      : upsertDeployTarget(graph, envId, next));
  };
  const field = (key: "name" | "tech" | "region" | "description", label: string, placeholder?: string) => (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">{label}</div>
      <Input
        value={draft[key] ?? ""}
        placeholder={placeholder}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        onBlur={() => patch({ ...draft, [key]: draft[key]?.trim() || (key === "name" ? target.name : undefined) })}
        onKeyDown={(event) => event.key === "Enter" && (event.target as HTMLInputElement).blur()}
      />
    </label>
  );

  return (
    <div className="border-b border-edge p-3">
      <div className="mb-2 flex items-center gap-2">
        <MapPin className="h-3.5 w-3.5 text-crystal-300" />
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{target.name}</span>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close target inspector"><X className="h-3.5 w-3.5" /></Button>
      </div>
      <div className="space-y-2">
        {field("name", "Name")}
        <label className="block">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Kind</div>
          <select
            className="h-8 w-full rounded-lg border border-edge bg-surface-2 px-2 text-xs text-ink outline-none"
            value={draft.kind}
            onChange={(event) => patch({ ...draft, kind: event.target.value as TargetKind })}
          >
            {TARGET_KINDS.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
          </select>
        </label>
        {field("tech", "Technology", "ECS Fargate, Kubernetes…")}
        {field("region", "Region", "us-east-1")}
        {field("description", "Description")}
        <div>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">Members ({members.length})</div>
          {members.map((member) => (
            <button key={member.id} type="button" onClick={() => onSelectMember(member.id)} className="block w-full truncate rounded-md px-2 py-1 text-left text-xs text-ink-muted hover:bg-surface-2 hover:text-ink">
              {member.label}
            </button>
          ))}
        </div>
        <Button variant="ghost" size="xs" className="text-danger" onClick={() => setConfirming(true)}><Trash2 className="h-3 w-3" /> Remove target</Button>
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent title={`Remove target “${target.name}”?`} description={`This also removes ${members.length} placement${members.length === 1 ? "" : "s"} from this environment.`}>
          <div className="flex justify-end gap-2">
            <DialogClose asChild><Button variant="ghost" size="sm">Cancel</Button></DialogClose>
            <Button variant="danger" size="sm" onClick={() => { onChange(deleteDeployTarget(graph, envId, target.id)); setConfirming(false); onClose(); }}>Remove target</Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
