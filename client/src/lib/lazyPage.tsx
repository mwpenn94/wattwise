/**
 * Oct 26 — route-level code splitting (OPEN-6).
 *
 * Each page is downloaded the first time it is opened instead of being part
 * of one 1.6 MB startup bundle. After a Publish, a tab that was opened on the
 * previous release may ask for a page file that no longer exists; in that case
 * the page reloads once (to pick up the new release) instead of showing an
 * error. At most one such reload happens per minute (timestamp in session
 * storage, never cleared by other pages loading), so a file that is genuinely
 * missing shows the normal error screen instead of reloading in a loop.
 */
import { Spinner } from "@/components/ui/spinner";
import { lazy, Suspense, type ComponentType } from "react";
// Route components accept any router props; pages ignore what they do not use.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyProps = any;

const RELOAD_AT = "meterly-chunk-reload-at";
const RELOAD_WINDOW_MS = 60_000;

function isChunkLoadError(e: unknown): boolean {
  const msg = String((e as { message?: unknown })?.message ?? e);
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError|Loading chunk [\w-]+ failed/i.test(msg);
}

export function lazyPage(load: () => Promise<{ default: ComponentType<AnyProps> }>): ComponentType<AnyProps> {
  const Lazy = lazy(async () => {
    try {
      return await load();
    } catch (e) {
      let recent = true; // if storage is unavailable, never auto-reload (no loop risk)
      try {
        const last = Number(sessionStorage.getItem(RELOAD_AT) ?? 0);
        recent = Date.now() - last < RELOAD_WINDOW_MS;
      } catch { /* storage unavailable */ }
      if (isChunkLoadError(e) && !recent) {
        try { sessionStorage.setItem(RELOAD_AT, String(Date.now())); } catch { /* storage unavailable */ }
        window.location.reload();
        // Keep showing the loading state while the browser reloads.
        return new Promise<{ default: ComponentType<AnyProps> }>(() => {});
      }
      throw e;
    }
  });
  function LazyPage(props: AnyProps) {
    return (
      <Suspense fallback={<PageLoading />}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return LazyPage;
}

export function PageLoading() {
  return (
    <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground" aria-live="polite">
      <Spinner className="size-5" />
      <span className="ml-2 text-sm">Loading…</span>
    </div>
  );
}
