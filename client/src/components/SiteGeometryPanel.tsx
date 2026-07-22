/**
 * GEO — stage 2b geometry & exposure panel (handoff v1.22 cycles 4/8/10).
 * Free-tier geometry per spec gating: footprint resolve (OSM, ODbL-flagged),
 * tap-to-confirm (nothing silently asserted), draw-your-own footprint,
 * prism 3D-style view honestly labeled as a prism estimate, orientation
 * compass + exposed-wall chips + exposure score heuristic.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, Compass, Loader2, MapPinned, Minus, Pencil, Plus, RotateCcw, Sun, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MapView } from "@/components/Map";
import { trpc } from "@/lib/trpc";

type Ring = [number, number][];

/** Shoelace area of a lng/lat ring in sqft — mirror of the server math, for the live draw readout. */
function ringAreaSqftClient(ring: Ring): number {
  if (ring.length < 3) return 0;
  const lat0 = (ring[0][1] * Math.PI) / 180;
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(lat0);
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += x1 * mPerDegLng * (y2 * mPerDegLat) - x2 * mPerDegLng * (y1 * mPerDegLat);
  }
  return Math.abs(sum / 2) * 10.7639;
}

interface Candidate {
  ring: Ring;
  areaSqft: number;
  footprintSqft: number;
  heightM: number;
  stories: number | null;
  orientationDeg: number;
  exposureScore: number;
  exposedWallAreaByOrientation: Record<string, number>;
  osmId?: string;
  distanceM?: number;
  prism?: boolean;
  source?: "osm" | "microsoft" | "usa_structures";
  heightSource?: "footprint_dataset" | "stories_estimate";
}

const ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

function PrismView({ footprintSqft, heightM, stories, prism }: { footprintSqft: number; heightM: number; stories: number | null; prism: boolean }) {
  // Simple isometric extrusion, proportions from area + height. Honest label.
  const side = Math.sqrt(Math.max(footprintSqft, 100)); // ft
  const wPx = Math.max(56, Math.min(150, side * 1.6));
  const dPx = wPx * 0.55;
  const hPx = Math.max(22, Math.min(120, heightM * 6));
  return (
    <div className="flex flex-col items-center gap-1.5">
      <svg width={wPx + dPx + 8} height={hPx + dPx * 0.5 + 14} aria-label="prism massing estimate">
        {/* top */}
        <polygon
          points={`${dPx},0 ${dPx + wPx},0 ${wPx},${dPx * 0.5} 0,${dPx * 0.5}`}
          className="fill-primary/30 stroke-primary/60"
          transform={`translate(4, 6)`}
        />
        {/* front */}
        <polygon
          points={`0,${dPx * 0.5} ${wPx},${dPx * 0.5} ${wPx},${dPx * 0.5 + hPx} 0,${dPx * 0.5 + hPx}`}
          className="fill-primary/15 stroke-primary/60"
          transform={`translate(4, 6)`}
        />
        {/* side */}
        <polygon
          points={`${wPx},${dPx * 0.5} ${wPx + dPx},0 ${wPx + dPx},${hPx} ${wPx},${dPx * 0.5 + hPx}`}
          className="fill-primary/25 stroke-primary/60"
          transform={`translate(4, 6)`}
        />
      </svg>
      <div className="text-[11px] text-muted-foreground text-center leading-tight">
        {prism ? "Prism estimate — massing synthesized from floor area, not a measured model" : "Extruded footprint — height from map data, not a measured scan"}
        <br />
        {Math.round(footprintSqft).toLocaleString()} sqft footprint · {heightM.toFixed(1)} m tall
        {stories ? ` · ~${stories} ${stories === 1 ? "story" : "stories"}` : ""}
      </div>
    </div>
  );
}

function CompassChip({ deg }: { deg: number }) {
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-10 w-10 rounded-full border border-border grid place-items-center">
        <span className="absolute top-0.5 text-[8px] text-muted-foreground">N</span>
        <div className="h-4 w-0.5 bg-primary origin-bottom" style={{ transform: `rotate(${deg}deg) translateY(-2px)` }} />
      </div>
      <div className="text-xs">
        <div className="font-medium">Long axis ≈ {Math.round(deg)}°</div>
        <div className="text-muted-foreground">from the longest footprint edge</div>
      </div>
    </div>
  );
}

export default function SiteGeometryPanel({ siteId }: { siteId: number }) {
  const utils = trpc.useUtils();
  const stored = trpc.sites.geometryGet.useQuery({ siteId }, { staleTime: 30_000 });
  const resolve = trpc.sites.geometryResolve.useMutation();
  const confirm = trpc.sites.geometryConfirm.useMutation({
    onSuccess: () => {
      utils.sites.geometryGet.invalidate({ siteId });
      utils.sites.dimensionReceipts.invalidate({ siteId });
      setPendingReplace(null);
      toast.success("Footprint confirmed — geometry now feeds your dimensional receipts");
    },
    onError: (e, vars) => {
      // GEO-BUG-2: server guards a hand-drawn footprint against silent
      // replacement — surface an explicit keep/replace choice instead.
      if (e.data?.code === "PRECONDITION_FAILED" && vars && vars.source !== "user_drawn") {
        setPendingReplace(vars);
        return;
      }
      toast.error(e.message);
    },
  });
  const [pendingReplace, setPendingReplace] = useState<Record<string, unknown> | null>(null);

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [fallback, setFallback] = useState<Candidate | null>(null);
  const [note, setNote] = useState<string>("");
  const [selected, setSelected] = useState<number | "prism" | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawnRing, setDrawnRing] = useState<Ring>([]);
  const [drawnStories, setDrawnStories] = useState(1);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<google.maps.Polygon[]>([]);
  const drawMarkersRef = useRef<google.maps.Marker[]>([]);
  const drawPreviewRef = useRef<google.maps.Polygon | null>(null);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const drawnSqft = useMemo(() => ringAreaSqftClient(drawnRing), [drawnRing]);

  const geom = stored.data;
  const hasStored = geom != null && geom.footprintSqft != null;

  const clearOverlays = () => {
    overlaysRef.current.forEach((p) => p.setMap(null));
    overlaysRef.current = [];
  };

  const clearDrawArtifacts = () => {
    drawMarkersRef.current.forEach((m) => m.setMap(null));
    drawMarkersRef.current = [];
    drawPreviewRef.current?.setMap(null);
    drawPreviewRef.current = null;
  };

  const paintCandidates = (cands: Candidate[], fb: Candidate | null, sel: number | "prism" | null) => {
    if (!mapRef.current) return;
    clearOverlays();
    const paint = (ring: Ring, active: boolean, dashed: boolean) => {
      const poly = new google.maps.Polygon({
        paths: ring.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: active ? "#d97706" : "#9ca3af",
        strokeWeight: active ? 2.5 : 1.5,
        strokeOpacity: dashed ? 0.7 : 0.95,
        fillColor: active ? "#f59e0b" : "#6b7280",
        fillOpacity: active ? 0.25 : 0.08,
        // Never intercept taps — clickable overlays were swallowing the
        // draw-mode taps right over the building (the exact spot users tap).
        clickable: false,
        map: mapRef.current,
      });
      overlaysRef.current.push(poly);
    };
    cands.forEach((c, i) => paint(c.ring, sel === i, false));
    if (fb && sel === "prism") paint(fb.ring, true, true);
    // GEO-BUG-3: always paint the stored/confirmed footprint (emerald) under
    // the candidates so "what I have" vs "what's suggested" is never ambiguous
    // — previously a re-resolve visually replaced the confirmed footprint.
    const storedRing = (geom?.footprint as { coordinates?: Ring[] } | null)?.coordinates?.[0];
    if (storedRing && storedRing.length >= 3) {
      const poly = new google.maps.Polygon({
        paths: storedRing.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: "#059669",
        strokeWeight: 2.5,
        strokeOpacity: 0.95,
        fillColor: "#10b981",
        fillOpacity: 0.1,
        clickable: false,
        map: mapRef.current,
      });
      overlaysRef.current.push(poly);
    }
    const focus = sel === "prism" ? fb : typeof sel === "number" ? cands[sel] : (cands[0] ?? fb);
    if (focus) {
      const b = new google.maps.LatLngBounds();
      focus.ring.forEach(([lng, lat]) => b.extend({ lat, lng }));
      mapRef.current.fitBounds(b, 48);
    }
  };

  useEffect(() => {
    if (mapReady) paintCandidates(candidates, fallback, selected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, candidates, fallback, selected, geom]);

  // Draw-your-own footprint: tap vertices; markers + a live preview polygon
  // track the ring. POI icons are disabled while drawing so taps near labeled
  // places aren't hijacked by Google's own click targets (the mobile bug).
  useEffect(() => {
    if (!mapRef.current) return;
    if (clickListenerRef.current) {
      clickListenerRef.current.remove();
      clickListenerRef.current = null;
    }
    mapRef.current.setOptions({ clickableIcons: !drawing, draggableCursor: drawing ? "crosshair" : undefined });
    if (drawing) {
      clickListenerRef.current = mapRef.current.addListener("click", (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const pt: [number, number] = [e.latLng.lng(), e.latLng.lat()];
        setDrawnRing((r) => [...r, pt]);
      });
    }
    return () => {
      clickListenerRef.current?.remove();
      clickListenerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, mapReady]);

  // Repaint draw markers + live preview polygon whenever the ring changes,
  // so undo and adds both stay visually in sync.
  useEffect(() => {
    if (!mapRef.current || !mapReady) return;
    clearDrawArtifacts();
    if (!drawing || drawnRing.length === 0) return;
    drawnRing.forEach(([lng, lat]) => {
      const marker = new google.maps.Marker({
        position: { lat, lng },
        map: mapRef.current!,
        clickable: false,
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 5, fillColor: "#d97706", fillOpacity: 1, strokeWeight: 1.5, strokeColor: "#fff" },
      });
      drawMarkersRef.current.push(marker);
    });
    if (drawnRing.length >= 2) {
      drawPreviewRef.current = new google.maps.Polygon({
        paths: drawnRing.map(([lng, lat]) => ({ lat, lng })),
        strokeColor: "#d97706",
        strokeWeight: 2,
        strokeOpacity: 0.9,
        fillColor: "#f59e0b",
        fillOpacity: drawnRing.length >= 3 ? 0.18 : 0,
        clickable: false,
        map: mapRef.current,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, drawnRing, mapReady]);

  const startResolve = () => {
    setResolveError(null);
    resolve.mutate(
      { siteId },
      {
        onSuccess: (res) => {
          const cands = (res.candidates ?? []) as unknown as Candidate[];
          const fb = (res.fallback ?? null) as unknown as Candidate | null;
          setCandidates(cands);
          setFallback(fb);
          setNote(res.note);
          setSelected(cands.length > 0 ? 0 : fb ? "prism" : null);
        },
        onError: (e) => {
          // GEO-BUG-3: don't leave the widget blank on a failed lookup — show a
          // visible error state with a retry, and keep any stored geometry view.
          setResolveError(e.message || "Footprint lookup failed — the map sources may be busy.");
        },
      },
    );
  };
  const [resolveError, setResolveError] = useState<string | null>(null);

  const confirmSelected = () => {
    if (drawing && drawnRing.length >= 3) {
      confirm.mutate({
        siteId,
        ring: drawnRing,
        source: "user_drawn",
        stories: drawnStories,
        heightM: drawnStories * 3.2,
      });
      setDrawing(false);
      setDrawnRing([]);
      return;
    }
    if (selected === "prism" && fallback) {
      confirm.mutate({ siteId, ring: fallback.ring, source: "prism", stories: fallback.stories ?? undefined });
      return;
    }
    if (typeof selected === "number" && candidates[selected]) {
      const c = candidates[selected];
      // Height pre-fill: OSM tags and USA Structures LiDAR heights are real
      // dataset measurements — send them. Microsoft footprints carry none, so
      // height falls back to the stories estimate server-side (disclosed).
      const datasetHeight = c.heightSource === "footprint_dataset";
      confirm.mutate({
        siteId,
        ring: c.ring,
        source: c.source ?? "osm",
        osmId: c.osmId,
        heightM: datasetHeight ? c.heightM : undefined,
        stories: c.stories ?? undefined,
      });
    }
  };

  const active: Candidate | null =
    drawing ? null : selected === "prism" ? fallback : typeof selected === "number" ? (candidates[selected] ?? null) : null;

  const wallAreas = (active?.exposedWallAreaByOrientation ?? (geom?.exposedWallAreaByOrientation as Record<string, number> | null)) || null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-primary" />
          Building geometry
          {hasStored ? <Badge variant="outline" className="text-[10px]">confirmed</Badge> : null}
        </CardTitle>
        <CardDescription>
          Footprint, height, and orientation sharpen the model — solar sizing, heating/cooling envelope losses, and the
          floor-area cross-check all read from here, for every commodity. You confirm; we never silently assert.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {hasStored && candidates.length === 0 && !resolve.isPending ? (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <PrismView
              footprintSqft={geom!.footprintSqft!}
              heightM={geom!.heightM ?? 4}
              stories={geom!.stories}
              prism={geom!.footprintSource == null}
            />
            <div className="space-y-1.5">
              {geom!.orientationDeg != null && <CompassChip deg={geom!.orientationDeg} />}
              {geom!.exposureScore != null && (
                <div className="flex items-center gap-1.5 text-xs">
                  <Sun className="h-3.5 w-3.5 text-amber-500" />
                  Exposure score {Math.round(geom!.exposureScore)}/100{" "}
                  <span className="text-muted-foreground">(heuristic)</span>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Source: {geom!.footprintSource === "user_drawn" ? "drawn by you — protected from auto-overwrite" : geom!.footprintSource ? geom!.footprintSource.replace(/_/g, " ") : "prism estimate"}
                {geom!.odblDerived ? " · © OpenStreetMap contributors (ODbL)" : ""}
              </div>
              <Button size="sm" variant="outline" onClick={startResolve} disabled={resolve.isPending}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" /> Re-resolve
              </Button>
            </div>
          </div>
        ) : null}

        {!hasStored && candidates.length === 0 && !resolve.isPending && !fallback ? (
          <Button size="sm" onClick={startResolve}>
            <MapPinned className="h-4 w-4 mr-1.5" /> Find my building footprint
          </Button>
        ) : null}

        {resolve.isPending && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Looking up mapped footprints near your site…
          </div>
        )}

        {resolveError && !resolve.isPending ? (
          <div className="rounded-md border border-amber-300/50 bg-amber-500/10 p-2.5 text-xs space-y-1.5">
            <p className="text-amber-700 dark:text-amber-400">{resolveError}</p>
            <Button size="sm" variant="outline" onClick={startResolve}>
              <RotateCcw className="h-3.5 w-3.5 mr-1" /> Try again
            </Button>
          </div>
        ) : null}

        {pendingReplace ? (
          <div className="rounded-md border border-amber-300/50 bg-amber-500/10 p-2.5 text-xs space-y-1.5">
            <p className="text-amber-700 dark:text-amber-400">
              This site already has a footprint you drew yourself — it stays unless you explicitly replace it with this
              mapped candidate.
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setPendingReplace(null)}>
                Keep my drawn footprint
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={confirm.isPending}
                onClick={() => confirm.mutate({ ...(pendingReplace as Parameters<typeof confirm.mutate>[0]), force: true })}
              >
                Replace with mapped candidate
              </Button>
            </div>
          </div>
        ) : null}

        {(candidates.length > 0 || fallback) && !resolve.isPending ? (
          <div className="space-y-3">
            {note && <p className="text-xs text-muted-foreground">{note}</p>}
            <MapView
              className="h-[260px] rounded-md overflow-hidden"
              initialZoom={19}
              onMapReady={(m) => {
                mapRef.current = m;
                m.setMapTypeId("satellite");
                setMapReady(true);
              }}
            />
            <div className="flex flex-wrap gap-1.5">
              {candidates.map((c, i) => (
                <Button
                  key={c.osmId ?? i}
                  size="sm"
                  variant={selected === i && !drawing ? "default" : "outline"}
                  onClick={() => {
                    setDrawing(false);
                    setSelected(i);
                  }}
                >
                  {Math.round(c.areaSqft).toLocaleString()} sqft
                  {c.distanceM != null ? ` · ${c.distanceM}m away` : ""}
                  {c.source === "microsoft" ? " · MS" : c.source === "usa_structures" ? " · FEMA" : ""}
                  {c.heightSource === "footprint_dataset" && c.stories ? ` · ~${c.stories} fl` : ""}
                </Button>
              ))}
              {fallback && (
                <Button
                  size="sm"
                  variant={selected === "prism" && !drawing ? "default" : "outline"}
                  onClick={() => {
                    setDrawing(false);
                    setSelected("prism");
                  }}
                >
                  Prism estimate · {Math.round(fallback.areaSqft).toLocaleString()} sqft
                </Button>
              )}
              <Button
                size="sm"
                variant={drawing ? "default" : "outline"}
                onClick={() => {
                  setDrawing((d) => !d);
                  setDrawnRing([]);
                }}
              >
                <Pencil className="h-3.5 w-3.5 mr-1" /> {drawing ? "Cancel drawing" : "Draw it myself"}
              </Button>
            </div>

            {drawing && (
              <div className="space-y-2">
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Tap the map to trace your building's corners — any shape works (L-shapes, wings, courtyards; up to 120
                  points). {drawnRing.length} point{drawnRing.length === 1 ? "" : "s"} so far, at least 3 needed.
                  {drawnRing.length >= 3 ? ` Enclosed area ≈ ${Math.round(drawnSqft).toLocaleString()} sqft.` : ""}
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" disabled={drawnRing.length === 0} onClick={() => setDrawnRing((r) => r.slice(0, -1))}>
                    <Undo2 className="h-3.5 w-3.5 mr-1" /> Undo last point
                  </Button>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className="text-muted-foreground">Stories:</span>
                    <Button size="icon" variant="outline" className="h-7 w-7" disabled={drawnStories <= 1} onClick={() => setDrawnStories((s) => Math.max(1, s - 1))} aria-label="Fewer stories">
                      <Minus className="h-3 w-3" />
                    </Button>
                    <span className="w-5 text-center font-medium">{drawnStories}</span>
                    <Button size="icon" variant="outline" className="h-7 w-7" disabled={drawnStories >= 120} onClick={() => setDrawnStories((s) => Math.min(120, s + 1))} aria-label="More stories">
                      <Plus className="h-3 w-3" />
                    </Button>
                    <span className="text-muted-foreground">≈ {(drawnStories * 3.2).toFixed(1)} m tall · sets wall areas &amp; massing</span>
                  </div>
                </div>
              </div>
            )}

            {active && !drawing ? (
              <div className="flex flex-wrap items-start gap-4">
                <PrismView footprintSqft={active.footprintSqft} heightM={active.heightM} stories={active.stories} prism={!!active.prism} />
                <div className="space-y-1.5">
                  <CompassChip deg={active.orientationDeg} />
                  <div className="flex items-center gap-1.5 text-xs">
                    <Sun className="h-3.5 w-3.5 text-amber-500" /> Exposure score {active.exposureScore}/100{" "}
                    <span className="text-muted-foreground">(heuristic)</span>
                  </div>
                  {wallAreas && (
                    <div className="flex flex-wrap gap-1">
                      {ORDER.filter((k) => (wallAreas[k] ?? 0) > 0).map((k) => (
                        <Badge key={k} variant="secondary" className="text-[10px] font-normal">
                          <Compass className="h-2.5 w-2.5 mr-0.5" /> {k} {Math.round(wallAreas[k]).toLocaleString()} sqft
                        </Badge>
                      ))}
                    </div>
                  )}
                  {active.heightSource === "footprint_dataset" && (
                    <div className="text-[10px] text-emerald-600 dark:text-emerald-400">
                      Height {active.heightM.toFixed(1)} m measured by the source dataset — pre-fills stories (≈{active.stories ?? Math.max(1, Math.round(active.heightM / 3.2))}); drawing it yourself overrides.
                    </div>
                  )}
                  {!drawing &&
                    typeof selected === "number" &&
                    candidates.length > 1 &&
                    candidates.some((c) => c.heightSource === "footprint_dataset" && Math.abs(c.heightM - (candidates[selected]?.heightM ?? 0)) > 3.2) && (
                      <div className="text-[10px] text-muted-foreground">
                        Nearby building parts have differing measured heights — if your building steps between sections, confirm the part that matches your address (or trace the tallest section yourself).
                      </div>
                    )}
                  {!active.prism && (
                    <div className="text-[10px] text-muted-foreground">
                      {active.source === "microsoft"
                        ? "Microsoft US Building Footprints (ODC-BY)"
                        : active.source === "usa_structures"
                          ? "FEMA USA Structures (public domain; heights from LiDAR/imagery where available)"
                          : "© OpenStreetMap contributors (ODbL)"}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <Button size="sm" onClick={confirmSelected} disabled={confirm.isPending || (drawing ? drawnRing.length < 3 : selected == null)}>
              {confirm.isPending ? <Loader2 className="h-4 w-4 mr-1.5 animate-spin" /> : null}
              {drawing ? "Confirm drawn footprint" : "Confirm this footprint"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
