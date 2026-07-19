/**
 * GEO — stage 2b geometry & exposure panel (handoff v1.22 cycles 4/8/10).
 * Free-tier geometry per spec gating: footprint resolve (OSM, ODbL-flagged),
 * tap-to-confirm (nothing silently asserted), draw-your-own footprint,
 * prism 3D-style view honestly labeled as a prism estimate, orientation
 * compass + exposed-wall chips + exposure score heuristic.
 */
import { useEffect, useRef, useState } from "react";
import { Building2, Compass, Loader2, MapPinned, Pencil, RotateCcw, Sun } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MapView } from "@/components/Map";
import { trpc } from "@/lib/trpc";

type Ring = [number, number][];

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
      toast.success("Footprint confirmed — geometry now feeds your dimensional receipts");
    },
    onError: (e) => toast.error(e.message),
  });

  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [fallback, setFallback] = useState<Candidate | null>(null);
  const [note, setNote] = useState<string>("");
  const [selected, setSelected] = useState<number | "prism" | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawnRing, setDrawnRing] = useState<Ring>([]);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlaysRef = useRef<google.maps.Polygon[]>([]);
  const drawMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[] | google.maps.Marker[]>([]);
  const clickListenerRef = useRef<google.maps.MapsEventListener | null>(null);
  const [mapReady, setMapReady] = useState(false);

  const geom = stored.data;
  const hasStored = geom != null && geom.footprintSqft != null;

  const clearOverlays = () => {
    overlaysRef.current.forEach((p) => p.setMap(null));
    overlaysRef.current = [];
    (drawMarkersRef.current as google.maps.Marker[]).forEach((m) => m.setMap?.(null));
    drawMarkersRef.current = [];
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
        map: mapRef.current,
      });
      overlaysRef.current.push(poly);
    };
    cands.forEach((c, i) => paint(c.ring, sel === i, false));
    if (fb && sel === "prism") paint(fb.ring, true, true);
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
  }, [mapReady, candidates, fallback, selected]);

  // Draw-your-own footprint: click vertices, Finish closes the ring.
  useEffect(() => {
    if (!mapRef.current) return;
    if (clickListenerRef.current) {
      clickListenerRef.current.remove();
      clickListenerRef.current = null;
    }
    if (drawing) {
      clickListenerRef.current = mapRef.current.addListener("click", (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;
        const pt: [number, number] = [e.latLng.lng(), e.latLng.lat()];
        setDrawnRing((r) => [...r, pt]);
        const marker = new google.maps.Marker({
          position: e.latLng,
          map: mapRef.current!,
          icon: { path: google.maps.SymbolPath.CIRCLE, scale: 4, fillColor: "#d97706", fillOpacity: 1, strokeWeight: 1, strokeColor: "#fff" },
        });
        (drawMarkersRef.current as google.maps.Marker[]).push(marker);
      });
    }
    return () => {
      clickListenerRef.current?.remove();
      clickListenerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, mapReady]);

  const startResolve = () => {
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
        onError: (e) => toast.error(e.message),
      },
    );
  };

  const confirmSelected = () => {
    if (drawing && drawnRing.length >= 3) {
      confirm.mutate({ siteId, ring: drawnRing, source: "user_drawn" });
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
      confirm.mutate({
        siteId,
        ring: c.ring,
        source: "osm",
        osmId: c.osmId,
        heightM: c.heightM,
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
          Footprint, height, and orientation sharpen the model — solar sizing, envelope estimates, and the floor-area
          cross-check all read from here. You confirm; we never silently assert.
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
                Source: {geom!.footprintSource ? geom!.footprintSource.replace(/_/g, " ") : "prism estimate"}
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
                  (drawMarkersRef.current as google.maps.Marker[]).forEach((m) => m.setMap?.(null));
                  drawMarkersRef.current = [];
                }}
              >
                <Pencil className="h-3.5 w-3.5 mr-1" /> {drawing ? "Cancel drawing" : "Draw it myself"}
              </Button>
            </div>

            {drawing && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Tap the map to trace your building's corners ({drawnRing.length} point{drawnRing.length === 1 ? "" : "s"} so far — at
                least 3), then confirm below.
              </p>
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
                  {!active.prism && (
                    <div className="text-[10px] text-muted-foreground">© OpenStreetMap contributors (ODbL)</div>
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
