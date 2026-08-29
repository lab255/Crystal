import { useCallback, useMemo, useRef } from "react";
import { MessagesSquare } from "lucide-react";
import {
  useAgents,
  useNav,
  useNavUpdate,
  useNeedsYou,
  usePermissions,
  useWorkflows,
  useWorkspace,
} from "@crystal/client";
import { attentionRunIds, MANAGER_PREAMBLE, type Workflow } from "@crystal/core";
import { EmptyState } from "@crystal/ui";
import { NewThread } from "./NewThread.js";
import { ThreadRail } from "./ThreadRail.js";
import { ThreadView } from "./ThreadView.js";
import { buildThreadGroups, filterThreadGroups, threadForRunId } from "./thread-model.js";
import { useThreadReadState } from "./thread-unread.js";

const EMPTY_WORKFLOWS: Workflow[] = [];

/**
 * The Threads mode: every agent conversation in the workspace as a
 * first-class chat. The rail is the inbox — needs-input floats to the top;
 * selecting a row opens the whole resume chain as one transcript with
 * questions and tool use inline and workers nested where they were
 * dispatched.
 */
export function ThreadsMode() {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const runs = useAgents((s) => s.runs);
  const needsYou = useNeedsYou();
  const pendingPermissions = usePermissions((s) => s.pending);
  const workflows = useWorkflows((s) => s.workflows ?? EMPTY_WORKFLOWS);
  const info = useWorkspace((s) => s.info);
  const link = useNav((l) => l.threads ?? null);
  const update = useNavUpdate();
  const { seen, pins, markSeen, togglePin } = useThreadReadState();

  const attention = useMemo(() => {
    const ids = attentionRunIds(needsYou);
    for (const permission of pendingPermissions) ids.add(permission.runId);
    return ids;
  }, [needsYou, pendingPermissions]);

  const namingContext = useMemo(
    () => ({
      stripPrefixes: [MANAGER_PREAMBLE],
      workflowNameOf: (id: string) => workflows.find((w) => w.id === id)?.name,
      taskTitleOf: (taskId: string) => {
        for (const { project } of info?.projects ?? []) {
          const task = project.tasks.find((t) => t.id === taskId);
          if (task) return task.title;
        }
        return null;
      },
    }),
    [workflows, info],
  );

  // The find filter is a rail-display concern only: selection resolves
  // against the UNFILTERED groups so cross-surface jumps (attention toasts,
  // palette, shared links) land even when a stale filter hides the row.
  const allGroups = useMemo(
    () =>
      buildThreadGroups({
        runs,
        attention,
        lastSeen: seen,
        pins,
        projectNameOf: (projectId) =>
          info?.projects.find((p) => p.project.id === projectId)?.project.name,
        namingContext,
      }),
    [runs, attention, seen, pins, info, namingContext],
  );
  const groups = useMemo(() => filterThreadGroups(allGroups, link?.find), [allGroups, link?.find]);

  const selected = threadForRunId(allGroups, link?.thread);
  const composing = Boolean(link?.compose) || (!selected && allGroups.length === 0);

  const onSeen = useCallback(
    (threadId: string, stamp: string) => markSeen(threadId, stamp),
    [markSeen],
  );

  return (
    <div ref={surfaceRef} className="flex h-full min-h-0">
      <ThreadRail
        groups={groups}
        selectedThreadId={selected?.id ?? null}
        find={link?.find ?? ""}
        onFind={(value) =>
          update({ threads: { ...link, find: value || undefined } })
        }
        onSelect={(threadId) =>
          // compose: null — selecting a thread must close the composer
          // (mergeSection keeps omitted keys, so it must be explicit).
          update({ threads: { thread: threadId, find: link?.find, compose: null } })
        }
        onTogglePin={togglePin}
        onCompose={() =>
          update({ threads: { find: link?.find, compose: !link?.compose || undefined } })
        }
        composing={composing}
        onFocusComposer={() => {
          surfaceRef.current?.querySelector<HTMLTextAreaElement>('textarea[aria-label^="Message"]')
            ?.focus();
        }}
      />
      {composing ? (
        <NewThread
          className="flex-1"
          onStarted={(runId) => update({ threads: { thread: runId, compose: null } })}
        />
      ) : selected ? (
        <ThreadView thread={selected} onSeen={onSeen} className="flex-1" />
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <EmptyState icon={MessagesSquare} title="Pick a thread">
            Select a conversation on the left, or start a new one.
          </EmptyState>
        </div>
      )}
    </div>
  );
}
