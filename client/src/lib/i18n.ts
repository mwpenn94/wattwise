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
const LS_KEY = "meterly.lang";
/** legacy key from the WattWise era — read once so existing users keep their choice */
const LEGACY_LS_KEY = "wattwise.lang";

const EN = {
  // landing / hero
  "hero.tagline": "See the dollars hiding in your utility bills",
  "hero.sub": "Electric, gas, water, sewer — address in, estimate out. Every added detail moves you up the accuracy ladder.",
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
  // §5c nav + footer
  "nav.howItWorks": "How it works",
  "nav.pricing": "Pricing",
  "footer.privacy": "Privacy policy",
  "footer.terms": "Terms of use",
  "footer.contact": "Contact",
  "footer.methodology": "Methodology",
  // GAP-R broader public-funnel coverage: section headings on the landing page
  "howit.title.pre": "One pipeline, actual ",
  "howit.title.em": "or hypothetical",
  "howit.sub": "Measured intervals and archetype-synthesized buildings flow through the identical analytics path — the only difference is the provenance label on the output.",
  "tiers.title": "Tiers",
} as const;

export type StringKey = keyof typeof EN;

const ES: Partial<Record<StringKey, string>> = {
  "hero.tagline": "Descubre los dólares escondidos en tus facturas de servicios",
  "hero.sub": "Electricidad, gas, agua, drenaje — ingresa una dirección y recibe un estimado. Cada detalle adicional te sube en la escalera de precisión.",
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
  "nav.howItWorks": "Cómo funciona",
  "nav.pricing": "Precios",
  "footer.privacy": "Política de privacidad",
  "footer.terms": "Términos de uso",
  "footer.contact": "Contacto",
  "footer.methodology": "Metodología",
  "howit.title.pre": "Una sola tubería, real ",
  "howit.title.em": "o hipotética",
  "howit.sub": "Los intervalos medidos y los edificios sintetizados por arquetipo pasan por la misma ruta analítica — la única diferencia es la etiqueta de procedencia en el resultado.",
  "tiers.title": "Niveles",
};

const TABLES: Record<Lang, Partial<Record<StringKey, string>>> = { en: EN, es: ES };

/** GAP-R — the public-funnel keys a Spanish speaker hits BEFORE trusting us
 * with data. The parity CI test enforces 100% ES coverage of this list, so a
 * new funnel string can't ship EN-only by accident. Console/analysis surfaces
 * are intentionally not on this list (disclosed via lang.consoleNote). */
export const REQUIRED_PUBLIC_FUNNEL: readonly StringKey[] = [
  "hero.tagline",
  "hero.sub",
  "cta.tryFree",
  "cta.seeEstimate",
  "cta.signIn",
  "ladder.title",
  "ladder.estimate",
  "ladder.good",
  "ladder.great",
  "ladder.measured",
  "ladder.promise",
  "estimator.addressPrompt",
  "estimator.disclaimer",
  "lang.label",
  "lang.consoleNote",
  "nav.howItWorks",
  "nav.pricing",
  "footer.privacy",
  "footer.terms",
  "footer.contact",
  "footer.methodology",
  "howit.title.pre",
  "howit.title.em",
  "howit.sub",
  "tiers.title",
] as const;

/** Test-only introspection: the raw tables, exported so the parity spec can
 * audit coverage without duplicating string lists. */
export const I18N_TABLES = { EN, ES } as const;

/* ---------- store ---------- */
let current: Lang = (() => {
  try {
    const saved = localStorage.getItem(LS_KEY) ?? localStorage.getItem(LEGACY_LS_KEY);
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
