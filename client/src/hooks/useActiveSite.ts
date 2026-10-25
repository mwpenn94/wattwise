import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useLocation, useSearch } from "wouter";
import { useAuth } from "@/_core/hooks/useAuth";
import { trpc } from "@/lib/trpc";

export const ACTIVE_SITE_STORAGE_KEY = "meterly.activeSiteId";

export function activeSiteStorageKey(userId?: number | null) {
  return userId != null ? `${ACTIVE_SITE_STORAGE_KEY}:${userId}` : ACTIVE_SITE_STORAGE_KEY;
}

function readStoredSiteId(key: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const value = Number(window.localStorage.getItem(key));
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function persistSiteId(key: string, siteId: number | null) {
  if (typeof window === "undefined") return;
  try {
    if (siteId == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, String(siteId));
  } catch {
    // Active-site continuity is a convenience; private browsing must still work.
  }
}

/** Explicit links preserve this tab's site, not a different tab's remembered site. */
export function siteHref(path: string, siteId: number | null | undefined) {
  if (siteId == null) return path;
  const [beforeHash, hash] = path.split("#", 2);
  const [pathname, search] = beforeHash.split("?", 2);
  const params = new URLSearchParams(search);
  params.set("site", String(siteId));
  return `${pathname}?${params}${hash ? `#${hash}` : ""}`;
}

/** Capture before async work. A→B→A and unmounts invalidate earlier work too. */
export function useSiteRequestGuard(siteId: number | null) {
  const version = useRef(0);
  useLayoutEffect(() => {
    version.current += 1;
    return () => { version.current += 1; };
  }, [siteId]);
  return useCallback(() => {
    const started = version.current;
    return () => started === version.current;
  }, []);
}

/** URL > valid per-user remembered selection > first allowed site. */
export function useActiveSite() {
  const { user } = useAuth();
  const ownedSites = trpc.sites.list.useQuery(undefined, { enabled: !!user });
  const sharedSites = trpc.sites.sharedWithMe.useQuery(undefined, { enabled: !!user });
  const ready = !!user && ownedSites.isSuccess && sharedSites.isSuccess;
  const available = useMemo(() => {
    if (!ready) return undefined;
    // Keep role metadata, and never render duplicate options when access overlaps.
    return Array.from(new Map([...ownedSites.data!, ...sharedSites.data!].map((site) => [site.id, site])).values());
  }, [ready, ownedSites.data, sharedSites.data]);
  const sites = {
    ...ownedSites,
    data: available,
    isLoading: !!user && (ownedSites.isLoading || sharedSites.isLoading),
    isError: ownedSites.isError || sharedSites.isError,
    error: ownedSites.error ?? sharedSites.error,
  };
  const search = useSearch();
  const [location, navigate] = useLocation();
  const storageKey = activeSiteStorageKey(user?.id);
  const requestedSiteId = useMemo(() => {
    const parsed = Number(new URLSearchParams(search).get("site"));
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, [search]);

  const { activeSiteId, validUrlSiteId } = useMemo(() => {
    const hasSite = (siteId: number | null): siteId is number => siteId != null && !!available?.some((site) => site.id === siteId);
    const urlSiteId = hasSite(requestedSiteId) ? requestedSiteId : null;
    const storedSiteId = readStoredSiteId(storageKey);
    const rememberedSiteId = hasSite(storedSiteId) ? storedSiteId : null;
    return {
      activeSiteId: urlSiteId ?? rememberedSiteId ?? available?.[0]?.id ?? null,
      validUrlSiteId: urlSiteId,
    };
  }, [requestedSiteId, available, storageKey]);

  const activeSite = useMemo(
    () => available?.find((site) => site.id === activeSiteId) ?? null,
    [activeSiteId, available],
  );

  const setActiveSite = useCallback(
    (siteId: number) => {
      if (!available?.some((site) => site.id === siteId)) return;
      persistSiteId(storageKey, siteId);
      navigate(siteHref(`${location}${search ? `?${search}` : ""}`, siteId), { replace: true });
    },
    [location, navigate, search, available, storageKey],
  );

  useEffect(() => {
    if (!ready) return; // Do not reject a shared deep link while either list is pending/failed.
    persistSiteId(storageKey, activeSiteId);
    if (validUrlSiteId != null) return;
    const params = new URLSearchParams(search);
    if (activeSiteId == null) params.delete("site");
    else params.set("site", String(activeSiteId));
    if (params.toString() === search) return;
    navigate(`${location}${params.size ? `?${params}` : ""}`, { replace: true });
  }, [activeSiteId, location, navigate, search, ready, storageKey, validUrlSiteId]);

  return { activeSiteId, activeSite, sites, ownedSites, setActiveSite };
}
