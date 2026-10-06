import type { ComponentPropsWithoutRef } from "react";

type Variant = "primary" | "secondary";

interface ButtonProps extends Omit<ComponentPropsWithoutRef<"button">, "className"> {
  variant?: Variant;
}

const VARIANTS: Record<Variant, string> = {
  primary: "bg-accent text-accent-foreground border border-transparent",
  secondary: "bg-background text-foreground border border-line",
};

/** A native button with a 44 by 44 pixel minimum target and visible focus (from globals.css). */
export function Button({ variant = "primary", type = "button", ...props }: ButtonProps) {
  return (
    <button
      {...props}
      type={type}
      className={`${VARIANTS[variant]} min-h-11 min-w-11 cursor-pointer rounded-md px-4 py-2 font-semibold disabled:cursor-not-allowed disabled:opacity-60`}
    />
  );
}
