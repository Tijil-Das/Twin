import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-[13px] font-medium transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 disabled:pointer-events-none disabled:opacity-50 active:scale-[0.98] cursor-pointer",
  {
    variants: {
      variant: {
        default:
          "bg-blue-600 hover:bg-blue-500 text-white border border-blue-500/40 rounded-lg",
        secondary:
          "bg-[var(--surface-2)] hover:bg-[var(--surface-3)] text-[var(--text)] border border-[var(--border)] shadow-sm rounded-lg",
        ghost:
          "text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--surface-2)] rounded-lg",
        destructive:
          "bg-red-500/15 hover:bg-red-500/25 text-red-400 border border-red-500/30 rounded-lg",
        subtle:
          "bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/25 rounded-lg",
      },
      size: {
        default: "h-8 px-3.5 py-1.5",
        sm: "h-7 px-2.5 text-xs rounded-md",
        lg: "h-9 px-4 text-sm rounded-lg",
        icon: "h-8 w-8 rounded-lg",
        iconSm: "h-7 w-7 rounded-md",
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
