"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface DropdownContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
}

const DropdownContext = React.createContext<DropdownContextValue | null>(null);

function useDropdown() {
  const ctx = React.useContext(DropdownContext);
  if (!ctx) throw new Error("Dropdown components must be used within <Dropdown>");
  return ctx;
}

export function Dropdown({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function escHandler(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handler);
    document.addEventListener("keydown", escHandler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("keydown", escHandler);
    };
  }, [open]);

  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div ref={ref} className={cn("relative inline-block", className)}>
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

export function DropdownTrigger({
  children,
  asChild,
}: {
  children: React.ReactElement;
  asChild?: boolean;
}) {
  const { open, setOpen } = useDropdown();
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setOpen(!open);
  };
  if (asChild) {
    return React.cloneElement(children, { onClick } as any);
  }
  return (
    <div onClick={onClick} className="cursor-pointer">
      {children}
    </div>
  );
}

export function DropdownContent({
  children,
  className,
  align = "start",
}: {
  children: React.ReactNode;
  className?: string;
  align?: "start" | "end" | "center";
}) {
  const { open } = useDropdown();
  if (!open) return null;
  const alignClass =
    align === "end"
      ? "right-0"
      : align === "center"
      ? "left-1/2 -translate-x-1/2"
      : "left-0";
  return (
    <div
      className={cn(
        "absolute z-50 mt-2 min-w-[200px] rounded-xl border border-[var(--border-default)] bg-[var(--bg-elevated)] p-1.5 shadow-xl animate-fade-in",
        alignClass,
        className
      )}
      role="menu"
    >
      {children}
    </div>
  );
}

export function DropdownItem({
  children,
  className,
  onClick,
  active,
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  active?: boolean;
}) {
  const { setOpen } = useDropdown();
  return (
    <button
      role="menuitem"
      onClick={() => {
        onClick?.();
        setOpen(false);
      }}
      className={cn(
        "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-[var(--text-primary)] transition-colors hover:bg-[var(--bg-hover)]",
        active && "bg-[var(--bg-hover)]",
        className
      )}
    >
      {children}
    </button>
  );
}

export function DropdownLabel({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]",
        className
      )}
    >
      {children}
    </div>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-[var(--border-subtle)]" />;
}