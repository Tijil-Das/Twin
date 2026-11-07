import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-lg text-xs font-medium transition-all duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/40 focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--bg)] disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default:
          "bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] active:bg-[var(--accent-pressed)] shadow-[0_1px_2px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.2)] border border-blue-400/30",
        secondary:
          "bg-[var(--surface-2)] text-[var(--text)] hover:bg-[var(--surface-3)] hover:text-white border border-[var(--border)] hover:border-[var(--border-strong)] shadow-[0_1px_2px_rgba(0,0,0,0.25)]",
        ghost:
          "border border-transparent text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)]",
        destructive:
          "bg-red-500/10 text-red-400 hover:bg-red-500/15 border border-red-500/20 hover:border-red-500/35",
        subtle:
          "bg-[var(--accent-subtle)] text-[var(--accent)] hover:bg-[var(--accent)]/15 border border-[var(--accent-border)]",
      },
      size: {
        default: "h-8 px-3 text-xs",
        sm: "h-7 px-2.5 text-[11.5px]",
        xs: "h-6 px-2 text-[11px]",
        lg: "h-9 px-4 text-sm",
        icon: "h-8 w-8",
        iconSm: "h-7 w-7",
        iconXs: "h-6 w-6",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
