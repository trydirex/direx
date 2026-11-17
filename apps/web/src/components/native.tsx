// SPDX-License-Identifier: AGPL-3.0-only
// Native controls in the Direx look, for the pages shown before the signed-in shell (sign-in, a reset,
// an invite, a new organization). Astryx loads with the shell, so those pages must not need it;
// elsewhere use Button and Input.
import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

const SIZE = { default: "min-h-8 px-3 text-sm", sm: "min-h-6.5 px-2.5 text-xs", lg: "min-h-10 px-5 text-base" } as const;
const VARIANT = {
  default: "bg-primary text-primary-foreground hover:bg-primary-hover",
  outline: "border-input bg-card text-foreground hover:bg-muted",
  ghost: "bg-transparent text-foreground hover:bg-muted",
} as const;

/** Classes that make a router Link, or a native button, look like a Button. */
export function buttonVariants(p: { variant?: keyof typeof VARIANT; size?: keyof typeof SIZE; className?: string } = {}) {
  return cn(
    "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-transparent font-medium whitespace-nowrap no-underline pointer-coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50",
    VARIANT[p.variant ?? "default"],
    SIZE[p.size ?? "default"],
    p.className,
  );
}

export function NativeButton({ variant, size, pending, disabled, className, type = "button", ...rest }: ComponentProps<"button"> & { variant?: keyof typeof VARIANT; size?: keyof typeof SIZE; pending?: boolean }) {
  return <button data-slot="button" type={type} disabled={disabled || pending} aria-busy={pending || undefined} className={buttonVariants({ variant, size, className })} {...rest} />;
}

export function NativeInput({ className, ...props }: ComponentProps<"input">) {
  return (
    <input
      data-slot="input"
      className={cn(
        "h-8 w-full min-w-0 rounded-control border border-input bg-card px-2.5 py-1 text-base pointer-coarse:h-11 transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}

export function NativeTextarea({ className, ...props }: ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-control border border-input bg-card px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  );
}
