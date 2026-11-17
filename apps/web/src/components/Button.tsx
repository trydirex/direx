// SPDX-License-Identifier: AGPL-3.0-only
// Direx's button: Astryx's Button, taking the props our screens pass. Visible text is the label (the
// accessible name) unless `label` or `aria-label` says otherwise; `pending` is Astryx's loading state,
// which blocks a second press and says it is busy while staying focusable.
import { Children, isValidElement, type ComponentProps, type ReactNode } from "react";
import { Button as AstryxButton } from "@astryxdesign/core/Button";
import { cn } from "@/lib/cn";

type Variant = "default" | "primary" | "outline" | "secondary" | "ghost" | "destructive" | "link";
type Size = "default" | "xs" | "sm" | "lg" | "icon" | "icon-xs" | "icon-sm" | "icon-lg";
const VARIANT = { default: "primary", primary: "primary", outline: "secondary", secondary: "secondary", ghost: "ghost", destructive: "destructive", link: "ghost" } as const;
// Astryx's secondary is a grey fill; our outline button is card white with the control border. Every
// button is a pill.
const OUTLINE = "border border-input bg-card hover:bg-muted";
const SIZE = { default: "md", xs: "sm", sm: "sm", lg: "lg", icon: "md", "icon-xs": "sm", "icon-sm": "sm", "icon-lg": "lg" } as const;

/** The text inside some children that a screen reader hears, for the accessible name. */
export function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((c) => {
      if (typeof c === "string" || typeof c === "number") return String(c);
      if (!isValidElement<{ children?: ReactNode; "aria-hidden"?: unknown }>(c) || c.props["aria-hidden"]) return "";
      return textOf(c.props.children);
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

type Props = Omit<ComponentProps<typeof AstryxButton>, "label" | "variant" | "size" | "isDisabled" | "isLoading" | "children"> & {
  variant?: Variant;
  size?: Size;
  pending?: boolean;
  disabled?: boolean;
  label?: string;
  children?: ReactNode;
};

export function Button({ variant = "default", size = "default", pending, disabled, label, children, className, ...rest }: Props) {
  const iconOnly = size.startsWith("icon");
  const text = label ?? rest["aria-label"] ?? textOf(children);
  const plain = typeof children === "string" && children.trim() === text;
  return (
    <AstryxButton
      {...rest}
      className={cn("rounded-control", variant === "outline" && OUTLINE, className)}
      label={text}
      variant={VARIANT[variant]}
      size={SIZE[size]}
      isDisabled={disabled}
      isLoading={pending}
      {...(iconOnly ? { isIconOnly: true, icon: children } : plain ? {} : { children })}
    />
  );
}

export { buttonVariants } from "./native";

/** A shortcut's key, shown on its button. Hidden from screen readers, which read aria-keyshortcuts. */
export function Key(p: { children: string }) {
  return (
    <kbd aria-hidden className="ml-1.5 rounded-sm border border-current px-1 font-sans text-xs opacity-80">
      {p.children}
    </kbd>
  );
}
