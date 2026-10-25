import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Oct 24 accessibility directive: user-selectable Light / Dark / System.
 * - "system" (default) follows the OS `prefers-color-scheme`, so a user who has
 *   asked their device for light or dark gets it without touching the app.
 * - The choice is saved per browser; an inline script in index.html applies it
 *   before first paint (no flash of the wrong theme).
 * - Print is always light (see @media print in index.css).
 */
export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "meterly-theme";

interface ThemeContextType {
  /** what is currently on screen */
  theme: ResolvedTheme;
  /** what the user chose */
  preference: ThemePreference;
  setPreference: (p: ThemePreference) => void;
  /** flips between light and dark (an explicit choice, no longer "system") */
  toggleTheme: () => void;
  switchable: true;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    /* storage unavailable (private mode) */
  }
  return "system";
}

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(theme: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  root.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#14161c" : "#fbfaf7");
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const [system, setSystem] = useState<ResolvedTheme>(systemTheme);

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = () => setSystem(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  // Keep tabs in sync when the choice changes in another window.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_STORAGE_KEY) setPreferenceState(readPreference());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const theme: ResolvedTheme = preference === "system" ? system : preference;

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  const setPreference = useCallback((p: ThemePreference) => {
    setPreferenceState(p);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, p);
    } catch {
      /* ignore */
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setPreference(theme === "dark" ? "light" : "dark");
  }, [theme, setPreference]);

  const value = useMemo<ThemeContextType>(
    () => ({ theme, preference, setPreference, toggleTheme, switchable: true }),
    [theme, preference, setPreference, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return context;
}
