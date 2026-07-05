import { forwardRef, type InputHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../cn.js";

const fieldClasses =
  "w-full rounded-lg border border-edge bg-surface-1 px-2.5 text-ink placeholder:text-ink-faint " +
  "focus:border-crystal-500/60 focus:outline-none focus:ring-2 focus:ring-crystal-500/20 transition-colors";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...props }, ref) {
    return <input ref={ref} className={cn(fieldClasses, "h-8 text-[13px]", className)} {...props} />;
  },
);

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(fieldClasses, "py-2 text-[13px] leading-relaxed resize-none", className)}
      {...props}
    />
  );
});
