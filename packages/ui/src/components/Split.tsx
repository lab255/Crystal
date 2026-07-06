import "react-split-pane/styles.css";
import { Children, isValidElement, cloneElement, type ReactElement } from "react";
import { Pane, SplitPane, type PaneProps, type SplitPaneProps } from "react-split-pane";
import { usePersistence } from "react-split-pane/persistence";
import { cn } from "../cn.js";

/**
 * Resizable split layout — react-split-pane v3 with Crystal divider styling
 * and per-layout size persistence. Compose `Split` with `Pane` children (2+),
 * nesting freely:
 *
 * ```tsx
 * <Split storageKey="architect" direction="horizontal">
 *   <Pane defaultSize={224} minSize={160}>…sidebar…</Pane>
 *   <Pane minSize="30%">…canvas…</Pane>
 * </Split>
 * ```
 *
 * The container must have explicit dimensions (`h-full min-h-0` inside a flex
 * parent works). Sizes persist to localStorage per `storageKey` *and* pane
 * count, so a layout that conditionally shows panes restores each variant.
 */
export interface SplitProps extends Omit<SplitPaneProps, "onResize"> {
  /** Persist pane sizes to localStorage under this key. */
  storageKey?: string;
}

export { Pane, type PaneProps };

export function Split({ storageKey, children, ...rest }: SplitProps) {
  const panes = Children.toArray(children);
  // SplitPane renders nothing (with a console warning) below two panes, but
  // layouts with conditional side panels routinely collapse to one — render
  // that lone pane's content full-size instead of disappearing the view.
  if (panes.length < 2) {
    const only = panes[0];
    const content =
      isValidElement<PaneProps>(only) && only.type === Pane ? only.props.children : only;
    return <div className={cn("h-full w-full", rest.className)}>{content}</div>;
  }
  // Remount when the pane count changes so persisted sizes re-load for the
  // matching layout variant (usePersistence reads storage on mount).
  return (
    <PersistentSplit key={`${storageKey ?? ""}:${panes.length}`} storageKey={storageKey} {...rest}>
      {children}
    </PersistentSplit>
  );
}

function PersistentSplit({
  storageKey,
  className,
  direction = "horizontal",
  children,
  ...rest
}: SplitProps) {
  const panes = Children.toArray(children);
  const [sizes, setSizes] = usePersistence({
    key: `crystal:split:${storageKey ?? "anon"}:${panes.length}`,
  });
  const restored = storageKey != null && sizes.length === panes.length;

  return (
    <SplitPane
      direction={direction}
      dividerSize={1}
      className={cn("crystal-split h-full w-full", className)}
      dividerClassName="crystal-split-divider"
      onResize={storageKey != null ? setSizes : undefined}
      {...rest}
    >
      {panes.map((child, i) =>
        restored && isValidElement<PaneProps>(child) && child.type === Pane
          ? cloneElement(child as ReactElement<PaneProps>, { size: sizes[i] })
          : child,
      )}
    </SplitPane>
  );
}
