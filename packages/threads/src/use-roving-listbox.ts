import { useEffect, useRef, type KeyboardEvent } from "react";

/** Shared keyboard contract for thread rails whose row buttons stay out of the tab order. */
export function useRovingListbox({
  ids,
  selectedId,
  onSelect,
  onEnter,
  onEscape,
}: {
  ids: readonly string[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onEnter: () => void;
  onEscape: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!selectedId) return;
    ref.current?.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  return {
    ref,
    tabIndex: 0,
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onEscape();
        return;
      }
      if (event.key === "Enter" && event.target === event.currentTarget) {
        event.preventDefault();
        onEnter();
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const index = ids.indexOf(selectedId ?? "");
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
          ? ids.length - 1
          : event.key === "ArrowDown"
            ? Math.min(ids.length - 1, index + 1)
            : Math.max(0, index < 0 ? 0 : index - 1);
      const id = ids[next];
      if (id) onSelect(id);
    },
  };
}
