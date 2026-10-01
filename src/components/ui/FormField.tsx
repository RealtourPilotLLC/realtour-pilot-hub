import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

type FieldProps = { id: string; label: string; hint?: ReactNode; error?: string | null; labelHidden?: boolean; className?: string };
export function fieldDescription({ id, hint, error }: Pick<FieldProps, "id" | "hint" | "error">, extra?: string) {
  return [extra, hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
}

/** Also usable around a native select/textarea: pass fieldDescription to that
 * control and aria-invalid when error is present. Errors retain caller input. */
export function FormField({ id, label, hint, error, labelHidden, className, children }: FieldProps & { children: ReactNode }) {
  return <div className={cn("min-w-0 space-y-1.5", className)}>
    <label htmlFor={id} className={labelHidden ? "sr-only" : "block text-sm font-medium text-foreground"}>{label}</label>
    {children}
    {hint && <div id={`${id}-hint`} className="text-sm leading-relaxed text-muted">{hint}</div>}
    {error && <p id={`${id}-error`} role="alert" className="text-sm font-medium text-danger">{error}</p>}
  </div>;
}

export function TextField({ id, label, hint, error, labelHidden, className, inputClassName, ...props }: FieldProps & Omit<ComponentProps<"input">, "id" | "className"> & { inputClassName?: string }) {
  return <FormField {...{ id, label, hint, error, labelHidden, className }}>
    <input {...props} id={id} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={fieldDescription({ id, hint, error }, props["aria-describedby"])}
      className={cn("min-h-11 w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-foreground placeholder:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-60", error && "border-danger", inputClassName)} />
  </FormField>;
}
