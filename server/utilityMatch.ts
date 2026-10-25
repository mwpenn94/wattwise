/**
 * Oct 24 — one place to decide whether a tariff row belongs to the utility a
 * site names. Users type abbreviations ("UES", "UNSE", "UniSource") that the
 * older first-word substring test never matched against the filed legal name
 * ("UniSource Energy Services (UNS Electric)"), which silently emptied the
 * same-utility rate list and pushed sites onto reference-only fallbacks.
 */
const ALIASES: Array<[RegExp, string]> = [
  // UniSource Energy Services — electric (UNS Electric) and gas (UNS Gas).
  [/^(ues|uesaz|unse|unsg|uns( electric| gas)?|unisource( energy( services)?)?)\b/, "unisource"],
  [/^(aps|arizona public service)\b/, "arizona public service"],
  [/^(srp|salt river( project)?)\b/, "salt river project"],
  [/^(tep|tucson electric( power)?)\b/, "tucson electric"],
  [/^(lg ?& ?e|lge|louisville gas)\b/, "louisville gas"],
];

export function normalizeUtility(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/&/g, " & ").replace(/[^a-z0-9& ]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Canonical match token for a user- or file-supplied utility name. */
export function utilityToken(name: string | null | undefined): string {
  const n = normalizeUtility(name);
  for (const [re, token] of ALIASES) if (re.test(n)) return token;
  return n.split(" ")[0] ?? "";
}

/** True when the tariff's utility is the one the site names (or the site names none). */
export function tariffMatchesSiteUtility(tariffUtilityName: string, siteUtilityName: string | null | undefined): boolean {
  if (!siteUtilityName || !siteUtilityName.trim()) return true;
  const tariff = normalizeUtility(tariffUtilityName);
  const token = utilityToken(siteUtilityName);
  if (!token) return true;
  return tariff.includes(token) || utilityToken(tariffUtilityName) === token;
}
