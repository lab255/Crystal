import type { HubProject, HubRecentProject } from "@crystal/core";
import { Select } from "@crystal/ui";

/**
 * Pick a project by root path. Open workspaces come first; recently-opened
 * ones follow and are reopened on dispatch, so a program can span projects
 * that are not currently loaded.
 */
export function ProjectSelect({
  value,
  onChange,
  projects,
  recents,
  className,
  ...rest
}: {
  value: string;
  onChange: (root: string) => void;
  projects: readonly HubProject[];
  recents: readonly HubRecentProject[];
  className?: string;
  "aria-label"?: string;
}) {
  // The reopen list minus directories that are gone — computed once, read twice.
  const usable = recents.filter((r) => !r.missing);
  return (
    <Select
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...rest}
    >
      <option value="">Pick a project…</option>
      {projects.length ? (
        <optgroup label="Open">
          {projects.map((p) => (
            <option key={p.root} value={p.root}>
              {p.name}
            </option>
          ))}
        </optgroup>
      ) : null}
      {usable.length ? (
        <optgroup label="Recent (reopened on dispatch)">
          {usable.map((r) => (
            <option key={r.root} value={r.root}>
              {r.name}
            </option>
          ))}
        </optgroup>
      ) : null}
    </Select>
  );
}
