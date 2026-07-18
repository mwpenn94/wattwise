/**
 * Estimate-first onboarding (UX addendum v1.9): the public landing page's
 * hero widget. Zero signup — type an address, confirm what it is, get a
 * grounded dollar estimate in under 60 seconds. Every number carries its
 * provenance, and the accuracy ladder shows exactly what upgrades it.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { startLogin } from "@/const";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  ArrowRight,
  Building2,
  Check,
  Factory,
  Home as HomeIcon,
  Hotel,
  Landmark,
  LocateFixed,
  MapPin,
  School,
  ShoppingBag,
  Store,
  Stethoscope,
  UtensilsCrossed,
  Warehouse,
} from "lucide-react";

const BUILDING_TYPES: Array<{ key: string; label: string; icon: typeof HomeIcon; residential?: boolean }> = [
  { key: "single_family", label: "Home", icon: HomeIcon, residential: true },
  { key: "multifamily", label: "Apartment", icon: Hotel, residential: true },
  { key: "office", label: "Office", icon: Building2 },
  { key: "retail", label: "Retail", icon: ShoppingBag },
  { key: "restaurant", label: "Restaurant", icon: UtensilsCrossed },
  { key: "grocery", label: "Grocery", icon: Store },
  { key: "warehouse", label: "Warehouse", icon: Warehouse },
  { key: "school", label: "School", icon: School },
  { key: "healthcare", label: "Healthcare", icon: Stethoscope },
  { key: "lodging", label: "Lodging", icon: Landmark },
  { key: "industrial", label: "Industrial", icon: Factory },
];

type Stage = "address" | "confirm" | "result";

export function PublicEstimator() {
  const { isAuthenticated } = useAuth();
  const [stage, setStage] = useState<Stage>("address");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [picked, setPicked] = useState<{ placeId: string; description: string } | null>(null);
  const [buildingType, setBuildingType] = useState<string | null>(null);
  const [dismissedSuggestions, setDismissedSuggestions] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 300);
    return () => clearTimeout(t);
  }, [query]);

  const suggestions = trpc.estimate.autocomplete.useQuery(
    { query: debounced },
    { enabled: debounced.length >= 4 && picked == null, staleTime: 60_000, retry: false },
  );

  const estimateMut = trpc.estimate.fromAddress.useMutation({
    onSuccess: () => setStage("result"),
  });

  // §1 demo building — zero-commitment sample estimate (no address typed).
  const [sampleData, setSampleData] = useState<{ estimate: NonNullable<typeof estimateMut.data>["estimate"]; place: NonNullable<typeof estimateMut.data>["place"] } | null>(null);
  const sampleMut = trpc.estimate.sample.useMutation({
    onSuccess: (data) => {
      setSampleData({ estimate: data.estimate, place: data.place });
      setStage("result");
    },
  });

  // §1b use-my-location — tap-triggered only (contextual permission rule);
  // the coordinate is sent once for reverse lookup and never stored.
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);
  const fromLocation = trpc.estimate.fromLocation.useMutation();
  const useMyLocation = () => {
    setLocateError(null);
    if (!navigator.geolocation) {
      setLocateError("Location isn't available in this browser — type your address instead.");
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const s = await fromLocation.mutateAsync({ lat: pos.coords.latitude, lng: pos.coords.longitude });
          if (s) {
            setPicked({ placeId: s.placeId, description: s.description });
            setDismissedSuggestions(true);
            setStage("confirm");
          } else {
            setLocateError("We couldn't match your location to a street address — type it instead.");
          }
        } catch {
          setLocateError("Location lookup failed — type your address instead.");
        } finally {
          setLocating(false);
        }
      },
      () => {
        setLocating(false);
        setLocateError("No problem — type your address instead. We only ask for location when you tap the button.");
      },
      { timeout: 8000, maximumAge: 60_000 },
    );
  };

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setDismissedSuggestions(true);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const est = sampleData?.estimate ?? estimateMut.data?.estimate;
  const place = sampleData?.place ?? estimateMut.data?.place;
  const isSample = sampleData != null;

  const mapUrl = useMemo(() => {
    if (!place || place.lat == null || place.lng == null) return null;
    // Static, key-less OSM embed for the confirm moment — shows the pin so the
    // user sees "that's my building" without loading the full Maps SDK.
    const d = 0.0035;
    return `https://www.openstreetmap.org/export/embed.html?bbox=${place.lng - d},${place.lat - d},${place.lng + d},${place.lat + d}&layer=mapnik&marker=${place.lat},${place.lng}`;
  }, [place]);

  return (
    <div ref={boxRef} className="rounded-lg border border-border bg-card/80 p-5 shadow-2xl">
      {/* stage: address */}
      {stage !== "result" && (
        <>
          <div className="mb-3 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              estimate my costs · no sign-up
            </span>
            <span className="prov-chip">~60 seconds</span>
          </div>
          <div className="relative">
            <MapPin className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={picked ? picked.description : query}
              placeholder="Enter your address…"
              className="pl-9"
              onChange={(e) => {
                setQuery(e.target.value);
                setPicked(null);
                setDismissedSuggestions(false);
                if (stage === "confirm") setStage("address");
              }}
              aria-label="Address for estimate"
            />
            {picked == null && !dismissedSuggestions && debounced.length >= 4 && (
              <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
                {suggestions.isFetching && (
                  <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                    <Spinner className="h-3 w-3" /> Searching addresses…
                  </div>
                )}
                {suggestions.data?.map((s) => (
                  <button
                    key={s.placeId}
                    type="button"
                    className="block w-full px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    onClick={() => {
                      setPicked({ placeId: s.placeId, description: s.description });
                      setStage("confirm");
                    }}
                  >
                    {s.description}
                  </button>
                ))}
                {suggestions.data && suggestions.data.length === 0 && !suggestions.isFetching && (
                  <p className="px-3 py-2 text-xs text-muted-foreground">No matches — keep typing or check the spelling.</p>
                )}
                {suggestions.error && (
                  <p className="px-3 py-2 text-xs text-destructive">{suggestions.error.message}</p>
                )}
              </div>
            )}
          </div>

          {/* stage: confirm building type */}
          {stage === "confirm" && picked && (
            <div className="mt-4">
              <p className="text-sm font-medium">What is this address?</p>
              <p className="text-xs text-muted-foreground">We never guess — a home and an office have very different bills.</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {BUILDING_TYPES.map((b) => (
                  <button
                    key={b.key}
                    type="button"
                    onClick={() => setBuildingType(b.key)}
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
                      buildingType === b.key
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-transparent text-muted-foreground hover:border-primary/50 hover:text-foreground"
                    }`}
                  >
                    <b.icon className="h-3.5 w-3.5" />
                    {b.label}
                    {buildingType === b.key && <Check className="h-3 w-3" />}
                  </button>
                ))}
              </div>
              <Button
                className="mt-4 w-full font-semibold"
                disabled={!buildingType || estimateMut.isPending}
                onClick={() => {
                  if (picked && buildingType) estimateMut.mutate({ placeId: picked.placeId, buildingType });
                }}
              >
                {estimateMut.isPending ? (
                  <>
                    <Spinner className="mr-2 h-4 w-4" /> Building your estimate…
                  </>
                ) : (
                  <>
                    Show my estimate <ArrowRight className="ml-1 h-4 w-4" />
                  </>
                )}
              </Button>
              {estimateMut.error && <p className="mt-2 text-xs text-destructive">{estimateMut.error.message}</p>}
            </div>
          )}
          {stage === "address" && (
            <>
              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  onClick={useMyLocation}
                  disabled={locating || fromLocation.isPending}
                >
                  {locating || fromLocation.isPending ? <Spinner className="h-3 w-3" /> : <LocateFixed className="h-3.5 w-3.5" />}
                  Use my location
                </button>
                <button
                  type="button"
                  className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground"
                  onClick={() => sampleMut.mutate()}
                  disabled={sampleMut.isPending}
                >
                  {sampleMut.isPending ? <Spinner className="h-3 w-3" /> : <Building2 className="h-3.5 w-3.5" />}
                  Try a sample Tucson office
                </button>
              </div>
              {locateError && <p className="mt-2 text-[11px] text-muted-foreground">{locateError}</p>}
              {sampleMut.error && <p className="mt-2 text-[11px] text-destructive">{sampleMut.error.message}</p>}
              <p className="mt-3 text-[11px] text-muted-foreground/80">
                Type your address, pick it from the list, and confirm what it is. Estimated from real building archetypes,
                local climate, and seeded utility rates — never your personal data. Location is only used when you tap the
                button, and never stored.
              </p>
            </>
          )}
        </>
      )}

      {/* stage: result */}
      {stage === "result" && est && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{isSample ? "sample estimate · demo building" : "your estimate"}</span>
            <span className="prov-chip">estimated</span>
          </div>

          {/* map confirm moment */}
          {mapUrl && (
            <div className="mb-3 overflow-hidden rounded-md border border-border">
              <iframe title="Your building" src={mapUrl} className="h-32 w-full" loading="lazy" />
              <p className="bg-muted/50 px-2 py-1 text-[10px] text-muted-foreground">
                <MapPin className="mr-1 inline h-3 w-3" />
                {place?.formattedAddress}
              </p>
            </div>
          )}

          {/* money-first headline */}
          <p className="font-display text-3xl font-extrabold tracking-tight stat-glow">
            ~${est.estimatedAnnualCostUsd.toLocaleString()}
            <span className="text-base font-semibold text-muted-foreground">/yr</span>
          </p>
          <p className="text-xs text-muted-foreground">
            ≈ ${est.estimatedMonthlyCostUsd.toLocaleString()}/mo · {est.estimatedAnnualKwh.toLocaleString()} kWh —{" "}
            {est.accuracy.label}
          </p>

          {est.topOpportunity && (
            <div className="mt-3 rounded-md border border-primary/30 bg-primary/5 p-3">
              <p className="text-xs font-semibold text-primary">
                Worth a look: save ~${est.topOpportunity.estimatedSavingsUsd.toLocaleString()}/yr
              </p>
              <p className="text-xs text-muted-foreground">
                {est.topOpportunity.title} — {est.topOpportunity.basis}.
              </p>
            </div>
          )}

          {/* accuracy ladder */}
          <div className="mt-4">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">accuracy ladder</p>
            <div className="mt-1.5 space-y-1">
              {/* v2.8 §1 ladder-as-contract: each rung names, in advance, the
                  specific insights the next upload unlocks — generated from the
                  capability matrix (v1.17 §5.0a), never vague encouragement. */}
              {est.accuracy.ladder.map((r, i) => (
                <div key={r.rung} className="flex gap-2 text-xs">
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] font-bold ${
                      r.current ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {i + 1}
                  </span>
                  <div className="min-w-0">
                    <p className="leading-tight">
                      <span className={r.current ? "font-semibold" : "text-muted-foreground"}>{r.label}</span>
                      <span className="text-[10px] text-muted-foreground/70"> — {r.unlockedBy}</span>
                    </p>
                    {"unlocks" in r && Array.isArray(r.unlocks) && r.unlocks.length > 0 && (
                      <p className="text-[10px] leading-snug text-muted-foreground/60">
                        Unlocks: {r.unlocks.join(" · ")}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* grounding provenance */}
          <details className="mt-3">
            <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-foreground">
              where these numbers come from
            </summary>
            <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground">
              <li>
                Location: {[est.grounding.location.city, est.grounding.location.state, est.grounding.location.zip].filter(Boolean).join(", ")}{" "}
                ({est.grounding.location.source === "place_verified" ? "verified address" : "parsed from text"})
              </li>
              <li>Climate zone {est.grounding.climateZone.value} · building type confirmed by you</li>
              <li>
                Size: {est.grounding.sqft.value.toLocaleString()} sqft (
                {est.grounding.sqft.source === "user_entered" ? "you entered it" : "median for this building type — refine inside"})
              </li>
              <li>Utility: {est.grounding.utility.name ?? "unknown"} — {est.grounding.utility.note}</li>
              <li>Rate: {est.grounding.tariff.name ?? "blended national rate"} — {est.grounding.tariff.note}</li>
              {est.percentileBand && <li>Peer context: {est.percentileBand} ({est.benchmarkSource})</li>}
            </ul>
            <p className="mt-1.5 text-[10px] italic text-muted-foreground/70">{est.disclosure}</p>
          </details>

          {/* next rung CTA */}
          <div className="mt-4 flex flex-col gap-2">
            <Button
              className="w-full font-semibold"
              onClick={() => (isAuthenticated ? (window.location.href = "/app") : startLogin())}
            >
              Make it accurate — add a bill <ArrowRight className="ml-1 h-4 w-4" />
            </Button>
            <button
              type="button"
              className="text-center text-[11px] text-muted-foreground underline-offset-2 hover:underline"
              onClick={() => {
                setStage("address");
                setPicked(null);
                setQuery("");
                setBuildingType(null);
                setSampleData(null);
                estimateMut.reset();
              }}
            >
              {isSample ? "Try my real address" : "Try another address"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
