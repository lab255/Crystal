import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { cn } from "../cn.js";

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

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
