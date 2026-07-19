/**
 * GAP-R EN/ES parity CI gate. Runs in the same vitest suite as the server
 * specs (i18n.ts is pure TS — the localStorage access is guarded, and t(key,
 * lang) needs no DOM), so a funnel string can't ship EN-only by accident:
 *  1. Every REQUIRED_PUBLIC_FUNNEL key has a non-empty ES translation.
 *  2. No ES value is a copy-paste of its EN value (untranslated strings are
 *     exactly the silent failure this gate exists to catch) — except keys the
 *     languages legitimately share (none today; list stays in the spec).
 *  3. ES has no orphan keys missing from EN (TypeScript enforces the type,
 *     this enforces it at runtime against the actual objects).
 *  4. t() falls back to EN for any hypothetical uncovered key rather than
 *     rendering a raw key or empty text.
 *  5. REQUIRED_PUBLIC_FUNNEL stays exhaustive: every EN key is either on the
 *     required list or deliberately excluded here — adding a key without
 *     classifying it fails CI.
 */
import { describe, expect, it } from "vitest";
import { I18N_TABLES, REQUIRED_PUBLIC_FUNNEL, t, type StringKey } from "../client/src/lib/i18n";

const { EN, ES } = I18N_TABLES;

/** Keys where identical EN/ES text is legitimate (brand names etc.). */
const ALLOWED_IDENTICAL: StringKey[] = [];

/** EN keys deliberately NOT on the required-funnel list (none today —
 * console-facing strings live outside i18n.ts until coverage expands). */
const EXCLUDED_FROM_FUNNEL: StringKey[] = [];

describe("GAP-R EN/ES parity gate", () => {
  it("every required public-funnel key has a non-empty ES translation", () => {
    const missing = REQUIRED_PUBLIC_FUNNEL.filter((k) => !ES[k] || ES[k]!.trim() === "");
    expect(missing, `ES translations missing for: ${missing.join(", ")}`).toEqual([]);
  });

  it("no ES value is untranslated EN copy-paste", () => {
    const copied = (Object.keys(ES) as StringKey[]).filter(
      (k) => !ALLOWED_IDENTICAL.includes(k) && ES[k] === EN[k],
    );
    expect(copied, `Untranslated ES strings: ${copied.join(", ")}`).toEqual([]);
  });

  it("ES has no orphan keys missing from EN", () => {
    const orphans = Object.keys(ES).filter((k) => !(k in EN));
    expect(orphans).toEqual([]);
  });

  it("t() falls back to EN, never a raw key or empty string", () => {
    for (const k of Object.keys(EN) as StringKey[]) {
      expect(t(k, "es")).toBeTruthy();
      expect(t(k, "en")).toBe(EN[k]);
    }
  });

  it("REQUIRED_PUBLIC_FUNNEL classifies every EN key (exhaustive by construction)", () => {
    const unclassified = (Object.keys(EN) as StringKey[]).filter(
      (k) => !REQUIRED_PUBLIC_FUNNEL.includes(k) && !EXCLUDED_FROM_FUNNEL.includes(k),
    );
    expect(unclassified, `Classify new keys as required or excluded: ${unclassified.join(", ")}`).toEqual([]);
  });
});
