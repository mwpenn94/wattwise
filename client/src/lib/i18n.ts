/**
 * EN/ES groundwork (v2.x checklist item "EN/ES").
 *
 * Deliberately light-touch: a typed string table + a language hook, not a
 * full i18n framework. Scope of this first pass is the PUBLIC funnel — the
 * surfaces a Spanish-speaking Arizona/Texas/California household hits before
 * trusting us with data (landing hero, estimator invite, ladder rungs, key
 * CTAs). Console/analysis surfaces stay EN until the string table grows —
 * honestly labeled below, never machine-translated silently.
 *
 * Contract:
 *  - `t(key)` returns the active-language string, falling back to EN so a
 *    missing translation NEVER renders a raw key or empty text.
 *  - Language preference: explicit user choice (localStorage) beats
 *    navigator.language; default EN.
 *  - Adding a language = adding a column to STRINGS; TypeScript enforces
 *    every EN key exists (ES may be partial by design, EN is the fallback).
 */
import { useSyncExternalStore } from "react";

export type Lang = "en" | "es";
const LS_KEY = "wattwise.lang";

const EN = {
  // landing / hero
  "hero.tagline": "See the dollars hiding in your utility data",
  "hero.sub": "Address in, estimate out — every added detail moves you up the accuracy ladder.",
  "cta.tryFree": "Try it free",
  "cta.seeEstimate": "See your estimate",
  "cta.signIn": "Sign in",
  // estimator / ladder
  "ladder.title": "The accuracy ladder",
  "ladder.estimate": "Estimate",
  "ladder.good": "Good",
  "ladder.great": "Great",
  "ladder.measured": "Measured",
  "ladder.promise": "Every rung names what it unlocks — before you upload anything.",
  "estimator.addressPrompt": "Type an address to see what your building is probably spending",
  "estimator.disclaimer": "Modeled estimate — not a guarantee. Ranges narrow as you add real data.",
  // language switcher
  "lang.label": "Language",
  "lang.consoleNote": "Analysis pages are English-only for now — Spanish coverage is expanding.",
} as const;

export type StringKey = keyof typeof EN;

const ES: Partial<Record<StringKey, string>> = {
  "hero.tagline": "Descubre los dólares escondidos en tus datos de energía",
  "hero.sub": "Ingresa una dirección y recibe un estimado — cada detalle adicional te sube en la escalera de precisión.",
  "cta.tryFree": "Pruébalo gratis",
  "cta.seeEstimate": "Ver tu estimado",
  "cta.signIn": "Iniciar sesión",
  "ladder.title": "La escalera de precisión",
  "ladder.estimate": "Estimado",
  "ladder.good": "Bueno",
  "ladder.great": "Excelente",
  "ladder.measured": "Medido",
  "ladder.promise": "Cada peldaño te dice qué desbloquea — antes de subir cualquier archivo.",
  "estimator.addressPrompt": "Escribe una dirección para ver cuánto probablemente gasta tu edificio",
  "estimator.disclaimer": "Estimado modelado — no es una garantía. Los rangos se ajustan al agregar datos reales.",
  "lang.label": "Idioma",
  "lang.consoleNote": "Las páginas de análisis están solo en inglés por ahora — la cobertura en español está creciendo.",
};

const TABLES: Record<Lang, Partial<Record<StringKey, string>>> = { en: EN, es: ES };

/* ---------- store ---------- */
let current: Lang = (() => {
  try {
    const saved = localStorage.getItem(LS_KEY);
    if (saved === "en" || saved === "es") return saved;
    return navigator.language?.toLowerCase().startsWith("es") ? "es" : "en";
  } catch {
    return "en";
  }
})();

const listeners = new Set<() => void>();

export function getLang(): Lang {
  return current;
}

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(LS_KEY, l);
    document.documentElement.lang = l;
  } catch {
    /* SSR/test env */
  }
  listeners.forEach((fn) => fn());
}

/** Translate a key in the active language, falling back to EN. */
export function t(key: StringKey, lang?: Lang): string {
  const l = lang ?? current;
  return TABLES[l][key] ?? EN[key];
}

/** React hook: re-renders on language change. */
export function useLang(): { lang: Lang; t: (key: StringKey) => string; setLang: (l: Lang) => void } {
  const lang = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => "en" as Lang,
  );
  return { lang, t: (key) => t(key, lang), setLang };
}
