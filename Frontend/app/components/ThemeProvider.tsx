"use client";
import { createContext, useContext, useEffect, useState } from "react";
import { settingsService } from "@/lib/settings";
import { normalizeTheme, resolveDark, type Theme } from "@/lib/theme";

const ThemeContext = createContext<{ theme: Theme; toggle: () => void }>({
  theme: "system",
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    let cleanupMedia = () => {};
    let activeTheme: Theme | undefined;
    const unsubscribe = settingsService.subscribe((settings) => {
      const next = normalizeTheme(settings.theme);
      if (next === activeTheme) return;
      cleanupMedia();
      cleanupMedia = () => {};
      activeTheme = next;
      setTheme(next);
      const media = typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)") : undefined;
      const apply = () => document.documentElement.classList.toggle(
        "dark", resolveDark(next, media?.matches ?? false),
      );
      apply();
      if (next !== "system" || !media) return;
      if (typeof media.addEventListener === "function" && typeof media.removeEventListener === "function") {
        media.addEventListener("change", apply);
        cleanupMedia = () => media.removeEventListener("change", apply);
      } else if (typeof media.addListener === "function" && typeof media.removeListener === "function") {
        media.addListener(apply);
        cleanupMedia = () => media.removeListener(apply);
      }
    });
    return () => { unsubscribe(); cleanupMedia(); };
  }, []);

  const toggle = () => {
    const current = normalizeTheme(settingsService.getSetting("theme"));
    settingsService.updateSettings({
      theme: current === "light" ? "dark" : current === "dark" ? "system" : "light",
    });
  };

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
