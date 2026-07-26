import { create } from "zustand";

type Theme = "dark" | "light" | "system";

interface UIState {
  theme: Theme;
  sidebarOpen: boolean;
  rightPanelOpen: boolean;
  composerExpanded: boolean;

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  setSidebarOpen: (open: boolean) => void;
  toggleRightPanel: () => void;
  setComposerExpanded: (expanded: boolean) => void;
}

function getInitialTheme(): Theme {
  if (typeof window === "undefined") return "dark";
  return (localStorage.getItem("chatddb-theme") as Theme) || "dark";
}

function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  // Remove all theme classes
  root.classList.remove("light", "system-theme");

  if (theme === "light") {
    root.classList.add("light");
  } else if (theme === "system") {
    root.classList.add("system-theme");
  }
  // dark: no class needed (default)

  localStorage.setItem("chatddb-theme", theme);
}

export const useUIStore = create<UIState>((set, get) => ({
  theme: getInitialTheme(),
  sidebarOpen: true,
  rightPanelOpen: false,
  composerExpanded: false,

  setTheme: (theme: Theme) => {
    applyTheme(theme);
    set({ theme });
  },

  toggleTheme: () => {
    const { theme } = get();
    const order: Theme[] = ["dark", "light", "system"];
    const idx = order.indexOf(theme);
    const next = order[(idx + 1) % order.length];
    applyTheme(next);
    set({ theme: next });
  },

  toggleSidebar: () => {
    set((state) => ({ sidebarOpen: !state.sidebarOpen }));
  },

  setSidebarOpen: (open: boolean) => {
    set({ sidebarOpen: open });
  },

  toggleRightPanel: () => {
    set((state) => ({ rightPanelOpen: !state.rightPanelOpen }));
  },

  setComposerExpanded: (expanded: boolean) => {
    set({ composerExpanded: expanded });
  },
}));
