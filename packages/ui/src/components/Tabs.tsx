import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "../cn.js";

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: TabsPrimitive.TabsListProps) {
  return (
    <TabsPrimitive.List
      className={cn("inline-flex items-center gap-0.5 rounded-lg bg-surface-1 p-0.5", className)}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: TabsPrimitive.TabsTriggerProps) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium text-ink-muted transition-colors",
        "hover:text-ink data-[state=active]:bg-surface-3 data-[state=active]:text-ink",
        "focus-visible:outline-2 focus-visible:outline-crystal-400",
        className,
      )}
      {...props}
    />
  );
}
