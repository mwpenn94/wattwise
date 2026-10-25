import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTheme, type ThemePreference } from "@/contexts/ThemeContext";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ value: ThemePreference; label: string; hint: string; Icon: typeof Sun }> = [
  { value: "light", label: "Light", hint: "Dark text on a light background", Icon: Sun },
  { value: "dark", label: "Dark", hint: "Light text on a dark background", Icon: Moon },
  { value: "system", label: "Match my device", hint: "Follows your device's light/dark setting", Icon: Monitor },
];

/** Compact Light / Dark / Match-device picker (keyboard and screen-reader friendly). */
export function ThemeToggle({ className, variant = "icon" }: { className?: string; variant?: "icon" | "labeled" }) {
  const { theme, preference, setPreference } = useTheme();
  const CurrentIcon = theme === "dark" ? Moon : Sun;
  const current = OPTIONS.find((o) => o.value === preference)!;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size={variant === "icon" ? "icon" : "sm"}
          className={cn(variant === "labeled" && "w-full justify-start gap-2", className)}
          aria-label={`Appearance: ${current.label}. Change light or dark mode`}
          data-testid="theme-toggle"
        >
          <CurrentIcon className="h-4 w-4" aria-hidden="true" />
          {variant === "labeled" && <span className="text-sm">Appearance: {current.label}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Appearance</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={preference} onValueChange={(v) => setPreference(v as ThemePreference)}>
          {OPTIONS.map(({ value, label, hint, Icon }) => (
            <DropdownMenuRadioItem key={value} value={value} data-testid={`theme-${value}`} className="items-start py-2">
              <Icon className="mr-2 mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="flex flex-col">
                <span className="text-sm">{label}</span>
                <span className="text-xs text-muted-foreground">{hint}</span>
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
