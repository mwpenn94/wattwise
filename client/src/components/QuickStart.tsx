/**
 * Progressive participation quick-start (Jul 2026).
 * One input — a free-text address OR a bill photo — produces an immediate
 * quick-win archetype analysis with every placeholder assumption disclosed.
 * Bill path: OCR output prefills an inline review form; on save it persists a
 * REAL bill record (lazily creating a bill-entry meter) before analysis runs.
 * Until the bill is saved, figures are honestly disclosed as placeholder-based.
 * Multi-step forms (wizard / full site dialog) remain strictly optional.
 */
import { useEffect, useRef, useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Building2, Check, Factory, Home as HomeIcon, Hotel, MapPin, Receipt, ShoppingCart, Sparkles, Store, Warehouse } from "lucide-react";
import { Link, useLocation } from "wouter";
import { fileToBase64 } from "@/lib/wattwiseUi";
import AnalysisProgress from "@/components/AnalysisProgress";
import { MapView } from "@/components/Map";

interface FieldConf {
  periodStart?: number;
  periodEnd?: number;
  totalUsage?: number;
  totalCost?: number;
  billedDemandKw?: number;
}
interface BillDraft {
  siteId: number;
  reason: string;
  source: "parsed_image" | "manual";
  periodStart: string;
  periodEnd: string;
  totalUsage: string;
  totalCost: string;
  billedDemandKw: string;
  /** §3 Hero 4 bill-scan overlay: object URL of the uploaded bill image so the
      user verifies extracted fields AGAINST the document, plus per-field
      confidence so low-confidence values are visibly flagged, not hidden. */
  imageUrl: string | null;
  fieldConf: FieldConf;
}

/** One-tap building-type confirmation (grounded intake, Jul 17): the intake
 *  never silently assumes "office" — the user confirms what the address is. */
const BUILDING_CHIPS: Array<{ value: string; label: string; icon: typeof HomeIcon }> = [
  { value: "single_family", label: "Home", icon: HomeIcon },
  { value: "multifamily", label: "Apartment / condo", icon: Building2 },
  { value: "office", label: "Office", icon: Building2 },
  { value: "retail", label: "Retail", icon: Store },
  { value: "restaurant", label: "Restaurant", icon: Store },
  { value: "warehouse", label: "Warehouse", icon: Warehouse },
  { value: "grocery", label: "Grocery", icon: ShoppingCart },
  { value: "hotel", label: "Hotel", icon: Hotel },
  { value: "school", label: "School", icon: Building2 },
  { value: "hospital", label: "Hospital", icon: Building2 },
  { value: "manufacturing", label: "Manufacturing", icon: Factory },
  { value: "municipal", label: "Municipal", icon: Building2 },
];
const PRIMARY_CHIPS = 6; // first row shown by default; "more…" reveals the rest

export default function QuickStart({ compact = false }: { compact?: boolean }) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const [address, setAddress] = useState("");
  const [phase, setPhase] = useState<"idle" | "creating" | "analyzing" | "saving">("idle");
  // §3h: track the site being analyzed so the live pipeline narration can poll it
  const [analyzingSiteId, setAnalyzingSiteId] = useState<number | null>(null);
  const [billDraft, setBillDraft] = useState<BillDraft | null>(null);
  const billRef = useRef<HTMLInputElement>(null);
  // Grounded intake state
  const [debounced, setDebounced] = useState("");
  const [selectedPlace, setSelectedPlace] = useState<{ placeId: string; description: string } | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [buildingType, setBuildingType] = useState<string | null>(null);
  const [showAllChips, setShowAllChips] = useState(false);
  // v1.18/v2.9 §1b a11y confirm path: the candidate list is an ordered, keyboard-
  // navigable listbox (↑↓ to move, Enter to confirm, Esc to dismiss) with ARIA
  // wiring — tap-to-confirm has a full keyboard/screen-reader equivalent; the
  // visual dropdown is progressive enhancement, not the only path.
  const [highlightIdx, setHighlightIdx] = useState(-1);
  const [utilityOverride, setUtilityOverride] = useState<string | null>(null);
  const suggestBoxRef = useRef<HTMLDivElement>(null);
  // GAP-O pin-drop / prospective-site mode: no address needed — click the map,
  // we reverse-geocode a LABEL (disclosed as approximate) and create the site as
  // prospective ("considering this location"), never claiming occupancy.
  const [pinMode, setPinMode] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number; label: string | null } | null>(null);
  const pinMarkerRef = useRef<google.maps.marker.AdvancedMarkerElement | google.maps.Marker | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(address.trim());
      setHighlightIdx(-1); // new query → new candidate ordering; stale highlight would confirm the wrong address
    }, 250);
    return () => clearTimeout(t);
  }, [address]);

  const suggestions = trpc.places.autocomplete.useQuery(
    { query: debounced },
    { enabled: debounced.length >= 3 && selectedPlace == null, staleTime: 60_000, retry: false },
  );
  const resolved = trpc.places.resolve.useQuery(
    { placeId: selectedPlace?.placeId ?? "" },
    { enabled: selectedPlace != null, staleTime: 300_000, retry: false },
  );

  // Close the suggestion popover on outside click
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (suggestBoxRef.current && !suggestBoxRef.current.contains(e.target as Node)) setSuggestOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const quickCreate = trpc.sites.quickCreate.useMutation();
  const analyze = trpc.analysis.run.useMutation();
  const billOcr = trpc.uploads.billOcr.useMutation();
  const billSave = trpc.bills.createForSite.useMutation();

    const busy = phase !== "idle";
  /** GAP-Q reveal moment — one address just became candidate providers for all
   * THREE commodities. Shown as a rich toast right after creation so the user
   * sees the “whoa” before the analysis lands; every line is a candidate with
   * its own honesty note server-side (never presented as verified). */
  function revealUtilities(triple?: { electric: { value: string | null }; gas: { value: string | null }; water: { value: string | null } }) {
    if (!triple) return;
    const lines = [
      triple.electric.value ? `⚡ ${triple.electric.value}` : null,
      triple.gas.value ? `🔥 ${triple.gas.value}` : null,
      triple.water.value ? `💧 ${triple.water.value}` : null,
    ].filter((l): l is string => l != null);
    if (lines.length < 2) return; // one candidate isn't a reveal — stay quiet
    toast.info(`One address → ${lines.length} likely utilities`, {
      description: `${lines.join("  ·  ")} — candidates from your location, not confirmations. Override any of them as bills arrive.`,
      duration: 9000,
    });
  }
  async function finishToDashboard(siteId: number) {
    setAnalyzingSiteId(siteId);
    await analyze.mutateAsync({ siteId });
    await Promise.all([utils.insights.invalidate(), utils.sites.list.invalidate()]);
    navigate(`/app?site=${siteId}`);
  }

  async function startFromPin() {
    if (!pin) {
      toast.error("Click the map to drop a pin first.");
      return;
    }
    if (!buildingType) {
      toast.error("Tap what this location is — home, office, retail… — so the analysis isn't built on a guess.");
      return;
    }
    setPhase("creating");
    try {
      const res = await quickCreate.mutateAsync({
        address: pin.label ?? `Pinned location (${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)})`,
        buildingType: buildingType as never,
        utilityName: utilityOverride?.trim() || undefined,
        pinLat: pin.lat,
        pinLng: pin.lng,
        prospective: true,
      });
      await utils.sites.list.invalidate();
      setPhase("analyzing");
      toast.success("Prospective site created from your pin — running a modeled-only quick analysis…");
      revealUtilities(res.utilityTriple);
      await finishToDashboard(res.id);
      toast.success("Modeled estimate ready — it's a what-if for a location you're considering, not a reading of anyone's usage.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Pin-drop start failed");
    } finally {
      setPhase("idle");
    }
  }

  async function startFromAddress() {
    if (address.trim().length < 3) {
      toast.error("Enter at least a city/state or ZIP — e.g. “Phoenix, AZ 85004”.");
      return;
    }
    if (!buildingType) {
      toast.error("Tap what this address is — home, office, retail… — so the analysis isn't built on a guess.");
      return;
    }
    setPhase("creating");
    try {
      const res = await quickCreate.mutateAsync({
        address: address.trim(),
        placeId: selectedPlace?.placeId,
        buildingType: buildingType as never,
        utilityName: utilityOverride?.trim() || undefined,
      });
      await utils.sites.list.invalidate();
      setPhase("analyzing");
      toast.success(
        res.parse.state
          ? `Site created for ${res.parse.city ? `${res.parse.city}, ` : ""}${res.parse.state}${res.parse.zip ? ` ${res.parse.zip}` : ""}${selectedPlace ? " (verified address)" : ""} — running quick analysis…`
          : "Site created (location not recognized — US-median assumptions disclosed) — running quick analysis…",
      );
      revealUtilities(res.utilityTriple);
      await finishToDashboard(res.id);
      toast.success("Quick-win analysis ready — remaining assumptions are disclosed; refine anything, anytime.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Quick start failed");
    } finally {
      setPhase("idle");
    }
  }

  async function startFromBill(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    setPhase("creating");
    try {
      // Site first, from whatever address text was typed (may be empty →
      // placeholder name + US-median assumptions, all disclosed).
      const res = await quickCreate.mutateAsync({
        address: address.trim().length >= 3 ? address.trim() : "Bill upload (address not provided)",
        placeId: selectedPlace?.placeId,
        buildingType: (buildingType as never) ?? undefined,
        utilityName: utilityOverride?.trim() || undefined,
      });
      await utils.sites.list.invalidate();
      const mime = f.type === "application/pdf" ? "application/pdf" : f.type === "image/png" ? "image/png" : "image/jpeg";
      // §3 Hero 4 overlay: keep a local preview so extracted fields are verified
      // against the document itself (images only — PDFs have no inline preview).
      const imageUrl = mime === "application/pdf" ? null : URL.createObjectURL(f);
      const b64 = await fileToBase64(f);
      const ocr = await billOcr.mutateAsync({ siteId: res.id, filename: f.name, contentBase64: b64, mime });
      if (ocr.status === "manual_entry_required") {
        setBillDraft({
          siteId: res.id,
          reason: `${ocr.reason} Enter the bill fields below — saving them attaches a real bill to your new site.`,
          source: "manual",
          periodStart: "",
          periodEnd: "",
          totalUsage: "",
          totalCost: "",
          billedDemandKw: "",
          imageUrl,
          fieldConf: {},
        });
        toast.warning("Automatic bill parsing unavailable — review the form below (your site was still created).");
      } else {
        const b = ocr.bill;
        setBillDraft({
          siteId: res.id,
          reason: ocr.needsReview
            ? `Low-confidence extraction (${(b.overallConfidence * 100).toFixed(0)}%) — verify every value against the bill before saving.`
            : `Extracted at ${(b.overallConfidence * 100).toFixed(0)}% confidence — confirm the values, then save.`,
          source: "parsed_image",
          periodStart: b.periodStart.value ?? "",
          periodEnd: b.periodEnd.value ?? "",
          totalUsage: b.totalUsage.value != null ? String(b.totalUsage.value) : "",
          totalCost: b.totalCostUsd.value != null ? String(b.totalCostUsd.value) : "",
          billedDemandKw: b.billedDemandKw.value != null ? String(b.billedDemandKw.value) : "",
          imageUrl,
          fieldConf: {
            periodStart: b.periodStart.confidence,
            periodEnd: b.periodEnd.confidence,
            totalUsage: b.totalUsage.confidence,
            totalCost: b.totalCostUsd.confidence,
            billedDemandKw: b.billedDemandKw.confidence,
          },
        });
        toast.success("Bill read — confirm the extracted values below to attach it to your site.");
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Quick start failed");
    } finally {
      setPhase("idle");
      if (billRef.current) billRef.current.value = "";
    }
  }

  function releaseBillImage() {
    if (billDraft?.imageUrl) URL.revokeObjectURL(billDraft.imageUrl);
  }

  async function saveBillAndAnalyze() {
    if (!billDraft) return;
    releaseBillImage();
    setPhase("saving");
    try {
      await billSave.mutateAsync({
        siteId: billDraft.siteId,
        periodStart: billDraft.periodStart,
        periodEnd: billDraft.periodEnd,
        totalUsage: Number(billDraft.totalUsage),
        usageUnit: "kWh",
        totalCostUsd: Number(billDraft.totalCost),
        billedDemandKw: billDraft.billedDemandKw ? Number(billDraft.billedDemandKw) : undefined,
        source: billDraft.source,
      });
      toast.success("Bill saved — running quick analysis…");
      const siteId = billDraft.siteId;
      setBillDraft(null);
      setPhase("analyzing");
      await finishToDashboard(siteId);
      toast.success("Quick-win analysis ready — building attributes still use disclosed placeholders until you refine them.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Bill save failed");
    } finally {
      setPhase("idle");
    }
  }

  async function skipBillAndAnalyze() {
    if (!billDraft) return;
    releaseBillImage();
    const siteId = billDraft.siteId;
    setBillDraft(null);
    setPhase("analyzing");
    try {
      toast.info("Continuing without the bill — this first analysis is placeholder-based until you add data.");
      await finishToDashboard(siteId);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setPhase("idle");
    }
  }

  const draftValid =
    billDraft != null &&
    billDraft.periodStart.length > 0 &&
    billDraft.periodEnd.length > 0 &&
    Number(billDraft.totalUsage) > 0 &&
    Number(billDraft.totalCost) > 0;

  return (
    <Card className={compact ? "border-primary/30" : "mx-auto max-w-xl border-primary/30"}>
      <CardContent className="py-5">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <p className="font-display text-sm font-semibold">Quick start — one input, instant analysis</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Type an address and pick it from the suggestions — we verify the location, you confirm what the building is,
          and the first-pass analysis runs on grounded facts with every remaining assumption disclosed.
        </p>
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1" ref={suggestBoxRef}>
            <MapPin className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Start typing an address…"
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setSelectedPlace(null);
                setSuggestOpen(true);
              }}
              onFocus={() => setSuggestOpen(true)}
              onKeyDown={(e) => {
                const list = suggestions.data ?? [];
                const listVisible = suggestOpen && selectedPlace == null && debounced.length >= 3 && list.length > 0;
                if (listVisible && e.key === "ArrowDown") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.min(i + 1, list.length - 1));
                  return;
                }
                if (listVisible && e.key === "ArrowUp") {
                  e.preventDefault();
                  setHighlightIdx((i) => Math.max(i - 1, 0));
                  return;
                }
                if (listVisible && e.key === "Escape") {
                  setSuggestOpen(false);
                  setHighlightIdx(-1);
                  return;
                }
                if (e.key === "Enter") {
                  if (listVisible && highlightIdx >= 0 && highlightIdx < list.length) {
                    e.preventDefault();
                    const s = list[highlightIdx];
                    setSelectedPlace({ placeId: s.placeId, description: s.description });
                    setAddress(s.description);
                    setSuggestOpen(false);
                    setHighlightIdx(-1);
                    return;
                  }
                  if (!busy && !billDraft) startFromAddress();
                }
              }}
              disabled={busy}
              aria-label="Building address"
              role="combobox"
              aria-expanded={suggestOpen && selectedPlace == null && (suggestions.data?.length ?? 0) > 0}
              aria-controls="address-candidate-listbox"
              aria-activedescendant={highlightIdx >= 0 ? `address-candidate-${highlightIdx}` : undefined}
              aria-autocomplete="list"
              autoComplete="off"
            />
            {suggestOpen && selectedPlace == null && debounced.length >= 3 && (suggestions.data?.length ?? 0) > 0 && (
              <div
                id="address-candidate-listbox"
                role="listbox"
                aria-label="Address candidates, ordered by match — use arrow keys and Enter to confirm"
                className="absolute left-0 right-0 top-full z-20 mt-1 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
              >
                {suggestions.data!.map((s, idx) => (
                  <button
                    key={s.placeId}
                    id={`address-candidate-${idx}`}
                    type="button"
                    role="option"
                    aria-selected={idx === highlightIdx}
                    className={`flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground ${idx === highlightIdx ? "bg-accent text-accent-foreground" : ""}`}
                    onMouseEnter={() => setHighlightIdx(idx)}
                    onClick={() => {
                      setSelectedPlace({ placeId: s.placeId, description: s.description });
                      setAddress(s.description);
                      setSuggestOpen(false);
                      setHighlightIdx(-1);
                    }}
                  >
                    <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span>
                      <span className="font-medium">{s.mainText}</span>
                      {s.secondaryText && <span className="text-muted-foreground"> — {s.secondaryText}</span>}
                    </span>
                  </button>
                ))}
                <p className="border-t px-3 py-1.5 text-[10px] text-muted-foreground">
                  Pick a suggestion to ground the analysis in a verified address — or keep typing free-text.
                </p>
              </div>
            )}
          </div>
          <Button onClick={startFromAddress} disabled={busy || billDraft != null || address.trim().length < 3 || !buildingType}>
            {phase === "creating" ? "Creating…" : phase === "analyzing" ? "Analyzing…" : "Analyze"}
          </Button>
        </div>
        {/* §3h: live pipeline narration — the engine's real stages, not theater */}
        {analyzingSiteId != null && (phase === "analyzing" || phase === "saving") && (
          <AnalysisProgress siteId={analyzingSiteId} active={true} />
        )}
        {selectedPlace && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 font-medium text-emerald-600 dark:text-emerald-400">
              <Check className="h-3 w-3" /> Verified address
            </span>
            {resolved.data && (
              <span className="text-muted-foreground">
                {[resolved.data.place.city, resolved.data.place.state, resolved.data.place.zip].filter(Boolean).join(", ")}
                {resolved.data.climateZone ? ` · climate zone ${resolved.data.climateZone}` : ""}
              </span>
            )}
          </div>
        )}
        {/* §3i-2 "one address, three utilities": show every commodity we hold rates
            for in this state. Copy says "rates loaded", never "your utility is" —
            the registry is our seeded snapshot, not a service-territory lookup. */}
        {selectedPlace && resolved.data?.place.state && <UtilitiesMoment state={resolved.data.place.state} />}
        {/* When pin mode is open the pin panel renders its own chips — don't show two competing selectors (they share the same buildingType state either way). */}
        {address.trim().length >= 3 && !billDraft && !pinMode && (
          <div className="mt-3">
            <p className="text-[11px] font-medium text-muted-foreground">
              What is this address? <span className="font-normal">(required — the archetype, size prior, and rate eligibility all depend on it)</span>
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {(showAllChips ? BUILDING_CHIPS : BUILDING_CHIPS.slice(0, PRIMARY_CHIPS)).map((c) => {
                const Icon = c.icon;
                const active = buildingType === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    disabled={busy}
                    onClick={() => setBuildingType(active ? null : c.value)}
                    className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border bg-transparent text-foreground hover:border-primary/50 hover:bg-primary/5"
                    }`}
                    aria-pressed={active}
                  >
                    <Icon className="h-3 w-3" /> {c.label}
                  </button>
                );
              })}
              {!showAllChips && (
                <button
                  type="button"
                  className="rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/50"
                  onClick={() => setShowAllChips(true)}
                >
                  more types…
                </button>
              )}
            </div>
            {resolved.data?.suggestedUtility && buildingType && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                <span>
                  Likely utility: <span className="font-medium text-foreground">{utilityOverride ?? resolved.data.suggestedUtility}</span>{" "}
                  <span className="text-muted-foreground">(largest in {resolved.data.place.state} — a suggestion, not verified for this address)</span>
                </span>
                <button
                  type="button"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={() => {
                    const v = window.prompt("Your electric utility (as shown on your bill):", utilityOverride ?? resolved.data!.suggestedUtility ?? "");
                    if (v != null) setUtilityOverride(v.trim() || null);
                  }}
                >
                  change
                </button>
              </div>
            )}
          </div>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => billRef.current?.click()}
            disabled={busy || billDraft != null}
          >
            <Receipt className="h-3.5 w-3.5" /> or start from a bill photo
          </button>
          <span aria-hidden>·</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-primary underline-offset-2 hover:underline disabled:opacity-50"
            onClick={() => setPinMode((v) => !v)}
            disabled={busy || billDraft != null}
            aria-pressed={pinMode}
          >
            <MapPin className="h-3.5 w-3.5" /> {pinMode ? "hide the map" : "or drop a pin instead"}
          </button>
          <span aria-hidden>·</span>
          <Link href="/app/wizard" className="underline-offset-2 hover:underline">
            prefer the guided step-by-step form?
          </Link>
        </div>

        {pinMode && !billDraft && (
          <div className="mt-3 rounded-md border border-border/70 p-2">
            <p className="text-[11px] text-muted-foreground">
              Click anywhere on the map to pin a location you're <span className="font-medium text-foreground">considering</span> — no
              address required. The site is created as <span className="font-medium text-foreground">prospective</span>: everything is a
              modeled what-if from location + building type, never a claim about who lives there or what they use.
            </p>
            <MapView
              className="mt-2 h-64 rounded-md"
              initialCenter={{ lat: 33.4484, lng: -112.074 }}
              initialZoom={10}
              onMapReady={(map) => {
                map.addListener("click", (e: google.maps.MapMouseEvent) => {
                  if (!e.latLng) return;
                  const lat = e.latLng.lat();
                  const lng = e.latLng.lng();
                  // one pin at a time — move it, don't stack markers
                  if (pinMarkerRef.current) {
                    if ("setMap" in pinMarkerRef.current && typeof (pinMarkerRef.current as google.maps.Marker).setMap === "function") {
                      (pinMarkerRef.current as google.maps.Marker).setMap(null);
                    } else {
                      (pinMarkerRef.current as google.maps.marker.AdvancedMarkerElement).map = null;
                    }
                  }
                  pinMarkerRef.current = new window.google.maps.Marker({ position: { lat, lng }, map });
                  setPin({ lat, lng, label: null });
                  // Reverse-geocode a human label — best-effort; the pin works without it.
                  try {
                    new window.google.maps.Geocoder().geocode({ location: { lat, lng } }, (results, status) => {
                      if (status === "OK" && results && results[0]) {
                        setPin({ lat, lng, label: results[0].formatted_address });
                      }
                    });
                  } catch {
                    /* label stays coordinates-only — disclosed */
                  }
                });
              }}
            />
            {/* Bug fix (owner report Jul 18): the building-type chips only rendered
                when ≥3 chars were typed in the address box, so pure pin-mode users
                were told to "pick a building type above" with nothing to pick.
                The chips now render inside the pin panel itself. */}
            <div className="mt-3">
              <p className="text-[11px] font-medium text-muted-foreground">
                What kind of building is at this pin?{" "}
                <span className="font-normal">(required — the archetype, size prior, and rate eligibility all depend on it)</span>
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {(showAllChips ? BUILDING_CHIPS : BUILDING_CHIPS.slice(0, PRIMARY_CHIPS)).map((c) => {
                  const Icon = c.icon;
                  const active = buildingType === c.value;
                  return (
                    <button
                      key={c.value}
                      type="button"
                      disabled={busy}
                      onClick={() => setBuildingType(active ? null : c.value)}
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-transparent text-foreground hover:border-primary/50 hover:bg-primary/5"
                      }`}
                      aria-pressed={active}
                    >
                      <Icon className="h-3 w-3" /> {c.label}
                    </button>
                  );
                })}
                {!showAllChips && (
                  <button
                    type="button"
                    className="rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground hover:border-primary/50"
                    onClick={() => setShowAllChips(true)}
                  >
                    more types…
                  </button>
                )}
              </div>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {pin ? (
                <p className="flex-1 text-[11px] text-muted-foreground">
                  Pinned: <span className="font-medium text-foreground">{pin.label ?? `${pin.lat.toFixed(4)}, ${pin.lng.toFixed(4)}`}</span>
                  {pin.label ? " (approximate label from the pin — not a verified address)" : " (coordinates only)"}
                </p>
              ) : (
                <p className="flex-1 text-[11px] text-muted-foreground">No pin yet — click the map.</p>
              )}
              <Button size="sm" onClick={startFromPin} disabled={busy || !pin || !buildingType}>
                {phase === "creating" ? "Creating…" : "Analyze this pin"}
              </Button>
            </div>
            {pin && !buildingType && (
              <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">Pick a building type just above so the modeled estimate has a real archetype.</p>
            )}
          </div>
        )}
        <input ref={billRef} type="file" hidden accept=".png,.jpg,.jpeg,.pdf" onChange={(e) => startFromBill(e.target.files)} />

        {billDraft && (
          <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/[0.04] p-3">
            <p className="text-xs font-medium">Confirm your bill — check each value against the document</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{billDraft.reason}</p>
            {billDraft.imageUrl && (
              /* §3 Hero 4 bill-scan overlay: the uploaded bill renders beside the
                 extracted fields so verification happens against the source, and
                 each field carries its extraction-confidence chip. */
              <div className="mt-2 max-h-64 overflow-auto rounded-md border border-border/70 bg-background">
                <img src={billDraft.imageUrl} alt="Your uploaded bill — verify the extracted values against it" className="w-full object-contain" />
              </div>
            )}
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <div>
                <Label htmlFor="qs-b-start" className="text-[11px]">
                  Period start <ConfChip conf={billDraft.fieldConf.periodStart} />
                </Label>
                <Input
                  id="qs-b-start"
                  type="date"
                  value={billDraft.periodStart}
                  onChange={(e) => setBillDraft({ ...billDraft, periodStart: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-end" className="text-[11px]">
                  Period end <ConfChip conf={billDraft.fieldConf.periodEnd} />
                </Label>
                <Input id="qs-b-end" type="date" value={billDraft.periodEnd} onChange={(e) => setBillDraft({ ...billDraft, periodEnd: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="qs-b-usage" className="text-[11px]">
                  Usage (kWh) <ConfChip conf={billDraft.fieldConf.totalUsage} />
                </Label>
                <Input
                  id="qs-b-usage"
                  type="number"
                  value={billDraft.totalUsage}
                  onChange={(e) => setBillDraft({ ...billDraft, totalUsage: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-cost" className="text-[11px]">
                  Total cost ($) <ConfChip conf={billDraft.fieldConf.totalCost} />
                </Label>
                <Input
                  id="qs-b-cost"
                  type="number"
                  value={billDraft.totalCost}
                  onChange={(e) => setBillDraft({ ...billDraft, totalCost: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="qs-b-demand" className="text-[11px]">
                  Billed demand (kW) <ConfChip conf={billDraft.fieldConf.billedDemandKw} />
                </Label>
                <Input
                  id="qs-b-demand"
                  type="number"
                  placeholder="optional"
                  value={billDraft.billedDemandKw}
                  onChange={(e) => setBillDraft({ ...billDraft, billedDemandKw: e.target.value })}
                />
              </div>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button size="sm" onClick={saveBillAndAnalyze} disabled={!draftValid || busy}>
                {phase === "saving" ? "Saving…" : "Save bill & analyze"}
              </Button>
              <Button size="sm" variant="ghost" onClick={skipBillAndAnalyze} disabled={busy}>
                Skip bill — analyze with placeholders
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** §3i-2 "one address, three utilities" — per-commodity providers we hold
    seeded rates for in the site's state. Explicitly a rates-loaded statement,
    not a service-territory claim. Renders nothing while loading or when the
    registry has no rows for the state (no fabricated providers). */
function UtilitiesMoment({ state }: { state: string }) {
  const reg = trpc.tariffs.utilitiesForState.useQuery({ state }, { staleTime: 5 * 60 * 1000 });
  if (!reg.data || reg.data.rateCount === 0) return null;
  const parts: string[] = [];
  if (reg.data.electric.length > 0) parts.push(`${reg.data.electric.join(" / ")} (electric)`);
  if (reg.data.gas.length > 0) parts.push(`${reg.data.gas.join(" / ")} (gas)`);
  if (reg.data.water.length > 0) parts.push(`${reg.data.water.join(" / ")} (water)`);
  if (parts.length === 0) return null;
  return (
    <p className="mt-1.5 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground">Rates loaded for {reg.data.state}:</span> {parts.join(" · ")} —{" "}
      {reg.data.rateCount} seeded rate{reg.data.rateCount === 1 ? "" : "s"}. We compare against these; confirm your actual
      provider on your bill.
    </p>
  );
}

/** Per-field extraction-confidence chip for the bill-scan overlay. Renders
    nothing when no confidence exists (manual entry) — a manual field is the
    user's own value, not an extraction to grade. */
function ConfChip({ conf }: { conf?: number }) {
  if (conf == null) return null;
  const pct = Math.round(conf * 100);
  const tone =
    conf >= 0.8
      ? "border-emerald-500/50 text-emerald-600 dark:text-emerald-400"
      : conf >= 0.5
        ? "border-amber-500/50 text-amber-600 dark:text-amber-400"
        : "border-red-500/50 text-red-600 dark:text-red-400";
  return (
    <span
      className={`ml-1 inline-block rounded border px-1 text-[9px] font-mono leading-4 ${tone}`}
      title={`Extraction confidence ${pct}% — verify against the bill image`}
    >
      {pct}%
    </span>
  );
}
