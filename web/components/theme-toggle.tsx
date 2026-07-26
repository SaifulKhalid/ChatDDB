"use client";

import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useUIStore } from "@/stores/ui-store";

export function ThemeToggle() {
  const { theme, toggleTheme } = useUIStore();

  const iconMap = {
    dark: <Moon className="h-4 w-4" />,
    light: <Sun className="h-4 w-4" />,
    system: <Monitor className="h-4 w-4" />,
  };

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={toggleTheme}
      className="text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      title={`Theme: ${theme}`}
    >
      {iconMap[theme]}
    </Button>
  );
}
