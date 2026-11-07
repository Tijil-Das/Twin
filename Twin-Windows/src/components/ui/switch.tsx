import * as React from "react";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { cn } from "@/lib/utils";

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    className={cn(
      "relative inline-flex h-[22px] w-[44px] shrink-0 cursor-pointer items-center rounded-[5px] transition-colors duration-150 select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40 disabled:cursor-not-allowed disabled:opacity-40",
      "data-[state=checked]:bg-[#0067c0] data-[state=checked]:border data-[state=checked]:border-[#0067c0] data-[state=unchecked]:bg-[#202020] data-[state=unchecked]:border data-[state=unchecked]:border-white/30 hover:data-[state=unchecked]:border-white/50",
      className
    )}
    {...props}
    ref={ref}
  >
    {/* Windows 11 Rounded Rectangular Sliding Thumb - clean, no line or circle */}
    <SwitchPrimitive.Thumb
      className={cn(
        "pointer-events-none block h-[16px] w-[16px] rounded-[3px] shadow-sm transition-transform duration-150 ease-out",
        "data-[state=checked]:translate-x-[25px] data-[state=checked]:bg-[#1b1f28]",
        "data-[state=unchecked]:translate-x-[3px] data-[state=unchecked]:bg-[#d1d5db]"
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = SwitchPrimitive.Root.displayName;

export { Switch };
