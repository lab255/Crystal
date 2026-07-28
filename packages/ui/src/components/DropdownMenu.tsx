import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Check } from "lucide-react";
import { cn } from "../cn.js";

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;
export const DropdownMenuRadioGroup = Dropdown.RadioGroup;

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: Dropdown.DropdownMenuContentProps) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content
        sideOffset={sideOffset}
        className={cn(
          "z-50 min-w-44 rounded-lg border border-edge-strong bg-surface-3 p-1 shadow-xl shadow-black/50",
          className,
        )}
        {...props}
      />
    </Dropdown.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: Dropdown.DropdownMenuItemProps) {
  return (
    <Dropdown.Item
      className={cn(
        "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-ink outline-none",
        "data-[highlighted]:bg-crystal-500/20 data-[disabled]:opacity-40",
        className,
      )}
      {...props}
    />
  );
}

const CHECKABLE_ITEM_CLASSES =
  "flex cursor-default items-center gap-2 rounded-md py-1.5 pl-7 pr-2 text-xs text-ink outline-none " +
  "data-[highlighted]:bg-crystal-500/20 data-[disabled]:opacity-40 relative";

const ITEM_INDICATOR = (
  <Dropdown.ItemIndicator className="absolute left-2 inline-flex">
    <Check className="h-3 w-3 text-crystal-300" />
  </Dropdown.ItemIndicator>
);

/**
 * Selection-bearing items — the current choice carries a check mark in a
 * fixed gutter. Before these existed every menu that marked its current row
 * hand-rolled a `<Check>` icon with ad-hoc spacing.
 */
export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: Dropdown.DropdownMenuCheckboxItemProps) {
  return (
    <Dropdown.CheckboxItem className={cn(CHECKABLE_ITEM_CLASSES, className)} {...props}>
      {ITEM_INDICATOR}
      {children}
    </Dropdown.CheckboxItem>
  );
}

/** One row of a `DropdownMenuRadioGroup` — exactly-one-of selection menus. */
export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: Dropdown.DropdownMenuRadioItemProps) {
  return (
    <Dropdown.RadioItem className={cn(CHECKABLE_ITEM_CLASSES, className)} {...props}>
      {ITEM_INDICATOR}
      {children}
    </Dropdown.RadioItem>
  );
}

export function DropdownMenuSeparator(props: Dropdown.DropdownMenuSeparatorProps) {
  return <Dropdown.Separator className="my-1 h-px bg-edge" {...props} />;
}

export function DropdownMenuLabel({ className, ...props }: Dropdown.DropdownMenuLabelProps) {
  return (
    <Dropdown.Label
      className={cn("px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint", className)}
      {...props}
    />
  );
}
