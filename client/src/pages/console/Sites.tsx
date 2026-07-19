import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Building2, FolderKanban, MoreVertical, Pencil, Plus, Trash2, Users, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useLocation } from "wouter";
import { ProvChip } from "@/components/Honesty";
import QuickStart from "@/components/QuickStart";

const BUILDING_TYPES = [
  ["single_family", "Single-family home"],
  ["multifamily", "Multifamily"],
  ["office", "Office"],
  ["retail", "Retail"],
  ["warehouse", "Warehouse"],
  ["school", "K-12 school"],
  ["grocery", "Grocery"],
  ["restaurant", "Restaurant"],
  ["hotel", "Hotel"],
  ["hospital", "Hospital"],
  ["manufacturing", "Manufacturing"],
] as const;

export default function Sites() {
  const utils = trpc.useUtils();
  const [, navigate] = useLocation();
  const sites = trpc.sites.list.useQuery();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", city: "", state: "AZ", zip: "", buildingType: "", sqft: "", vintage: "", utilityName: "", tenure: "own", hasSolar: false });

  const create = trpc.sites.create.useMutation({
    onSuccess: async () => {
      toast.success("Site created");
      setOpen(false);
      setForm({ name: "", city: "", state: "AZ", zip: "", buildingType: "", sqft: "", vintage: "", utilityName: "", tenure: "own", hasSolar: false });
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="container max-w-5xl py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight">Sites</h1>
          <p className="mt-1 text-sm text-muted-foreground">Buildings under analysis — real or hypothetical.</p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button>
              <Plus className="mr-1 h-4 w-4" /> Add site
            </Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="font-display">New site</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <Label htmlFor="s-name">Name *</Label>
                <Input id="s-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Main office" />
              </div>
              <div>
                <Label htmlFor="s-city">City</Label>
                <Input id="s-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="Phoenix" />
              </div>
              <div>
                <Label htmlFor="s-state">State</Label>
                <Input id="s-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value.toUpperCase().slice(0, 2) })} placeholder="AZ" />
              </div>
              <div>
                <Label htmlFor="s-zip">ZIP</Label>
                <Input id="s-zip" value={form.zip} onChange={(e) => setForm({ ...form, zip: e.target.value })} placeholder="85004" />
              </div>
              <div>
                <Label>Building type</Label>
                <Select value={form.buildingType} onValueChange={(v) => setForm({ ...form, buildingType: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select…" />
                  </SelectTrigger>
                  <SelectContent>
                    {BUILDING_TYPES.map(([v, l]) => (
                      <SelectItem key={v} value={v}>
                        {l}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="s-sqft">Square feet</Label>
                <Input id="s-sqft" type="number" value={form.sqft} onChange={(e) => setForm({ ...form, sqft: e.target.value })} placeholder="25000" />
              </div>
              <div>
                <Label htmlFor="s-vintage">Year built</Label>
                <Input id="s-vintage" type="number" value={form.vintage} onChange={(e) => setForm({ ...form, vintage: e.target.value })} placeholder="1998" />
              </div>
              <div className="col-span-2">
                <Label htmlFor="s-util">Utility</Label>
                <Input id="s-util" value={form.utilityName} onChange={(e) => setForm({ ...form, utilityName: e.target.value })} placeholder="APS / SRP / TEP…" />
              </div>
              {/* v1.18 tenure modes — recommendations are filtered to what you can actually do */}
              <div>
                <Label>Do you own or rent?</Label>
                <Select value={form.tenure} onValueChange={(v) => setForm({ ...form, tenure: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="own">Own</SelectItem>
                    <SelectItem value="rent">Rent</SelectItem>
                    <SelectItem value="condo_hoa">Condo / HOA</SelectItem>
                  </SelectContent>
                </Select>
                {form.tenure !== "own" && (
                  <p className="mt-1 text-xs text-muted-foreground">Your feed will lead with savings in your control; building upgrades go to a separate “worth raising” list.</p>
                )}
              </div>
              <div>
                <Label>Solar panels on site?</Label>
                <Select value={form.hasSolar ? "yes" : "no"} onValueChange={(v) => setForm({ ...form, hasSolar: v === "yes" })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="no">No</SelectItem>
                    <SelectItem value="yes">Yes</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Some rate plans are solar-only or closed to solar customers — this keeps your rate comparison lawful.</p>
              </div>
            </div>
            <Button
              className="mt-2 w-full"
              disabled={!form.name || create.isPending}
              onClick={() =>
                create.mutate({
                  name: form.name,
                  city: form.city || undefined,
                  state: form.state || undefined,
                  zip: form.zip || undefined,
                  buildingType: form.buildingType || undefined,
                  sqft: form.sqft ? Number(form.sqft) : undefined,
                  vintage: form.vintage ? Number(form.vintage) : undefined,
                  utilityName: form.utilityName || undefined,
                  tenure: form.tenure as "own" | "rent" | "condo_hoa",
                  hasSolar: form.hasSolar,
                })
              }
            >
              {create.isPending ? "Creating…" : "Create site"}
            </Button>
          </DialogContent>
        </Dialog>
      </div>

      <div className="mt-6">
        <QuickStart compact />
      </div>

      <EntityManager />

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        {sites.isLoading && (
          <>
            <Skeleton className="h-36" />
            <Skeleton className="h-36" />
          </>
        )}
        {(sites.data ?? []).map((s) => (
          <Card key={s.id} className="cursor-pointer border-border/70 transition-transform hover:-translate-y-0.5" onClick={() => navigate(`/app?site=${s.id}`)}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <Building2 className="h-4 w-4 text-primary" /> {s.name}
              </CardTitle>
              <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                {s.isHypothetical ? <ProvChip>hypothetical</ProvChip> : <ProvChip>actual</ProvChip>}
                <SiteActions site={s} />
              </div>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {s.city && <span>{s.city}, {s.state}</span>}
                {s.buildingType && <Badge variant="secondary" className="text-[10px]">{s.buildingType.replace(/_/g, " ")}</Badge>}
                {s.sqft && <span>{s.sqft.toLocaleString()} sqft</span>}
                {s.climateZone && <span>CZ {s.climateZone}</span>}
              </div>
              <SiteMeters siteId={s.id} state={s.state} />
              <SiteEntityPicker siteId={s.id} entityId={(s as { entityId?: number | null }).entityId ?? null} />
            </CardContent>
          </Card>
        ))}
        {!sites.isLoading && (sites.data ?? []).length === 0 && (
          <Card className="col-span-full border-dashed">
            <CardContent className="flex flex-col items-center py-10 text-center">
              <Building2 className="h-8 w-8 text-muted-foreground" />
              <p className="mt-3 font-medium">No sites yet</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                Add a site then upload interval data, or model a fully hypothetical building from the wizard.
              </p>
            </CardContent>
          </Card>
        )}
      </div>

      <SharedWithMe />
    </div>
  );
}

/** GAP-L: sites other owners shared with me — my role is shown on each card
 * (facility manager = can act; read-only = can look). */
function SharedWithMe() {
  const [, navigate] = useLocation();
  const shared = trpc.sites.sharedWithMe.useQuery();
  if (shared.isLoading || (shared.data ?? []).length === 0) return null;
  return (
    <div className="mt-8">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Users className="h-4 w-4 text-primary" /> Shared with me
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Sites other accounts gave you access to. Facility managers can refine and act; read-only can view everything but change nothing.
      </p>
      <div className="mt-3 grid gap-4 md:grid-cols-2">
        {(shared.data ?? []).map((s) => (
          <Card key={s.id} className="cursor-pointer border-border/70 transition-transform hover:-translate-y-0.5" onClick={() => navigate(`/app?site=${s.id}`)}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="flex items-center gap-2 font-display text-base">
                <Building2 className="h-4 w-4 text-primary" /> {s.name}
              </CardTitle>
              <Badge variant="outline" className="text-[10px]">
                {s.myRole === "facility_manager" ? "facility manager — can act" : "read-only — can look"}
              </Badge>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
                {s.city && <span>{s.city}, {s.state}</span>}
                {s.buildingType && <Badge variant="secondary" className="text-[10px]">{s.buildingType.replace(/_/g, " ")}</Badge>}
                {s.sqft && <span>{s.sqft.toLocaleString()} sqft</span>}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

/** GAP-L: owner-side sharing manager — add by email (account must exist; we say
 * so instead of pretending an invitation email was sent), choose role, remove. */
function SharePanel({ siteId, open, onClose }: { siteId: number; open: boolean; onClose: () => void }) {
  const utils = trpc.useUtils();
  const members = trpc.sites.members.list.useQuery({ siteId }, { enabled: open });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"facility_manager" | "read_only">("read_only");
  const add = trpc.sites.members.add.useMutation({
    onSuccess: async (r) => {
      toast.success(`${r.name ?? "Member"} added`);
      setEmail("");
      await utils.sites.members.list.invalidate({ siteId });
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.sites.members.remove.useMutation({
    onSuccess: async () => {
      toast.success("Access removed");
      await utils.sites.members.list.invalidate({ siteId });
    },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-display">
            <Users className="h-4 w-4 text-primary" /> Share this site
          </DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Grant another Meterly account access. <strong>Facility manager</strong> can refine attributes and mark measures;{" "}
          <strong>read-only</strong> can view analyses and insights but change nothing. The person must have signed in to
          Meterly at least once — no invitation email is sent from here.
        </p>
        <div className="flex flex-col gap-2">
          <Input placeholder="their-email@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Member email" />
          <div className="flex gap-2">
            <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
              <SelectTrigger className="flex-1"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="read_only">Read-only — can look</SelectItem>
                <SelectItem value="facility_manager">Facility manager — can act</SelectItem>
              </SelectContent>
            </Select>
            <Button disabled={!email.includes("@") || add.isPending} onClick={() => add.mutate({ siteId, email: email.trim(), role })}>
              {add.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
        </div>
        <div className="mt-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Current access</p>
          {(members.data ?? []).length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">Only you.</p>
          ) : (
            <ul className="mt-1 space-y-1.5">
              {(members.data ?? []).map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2 rounded-md border border-border/70 px-2.5 py-1.5">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium">{m.name ?? m.email ?? `user #${m.userId}`}</p>
                    <p className="text-[10px] text-muted-foreground">{m.role === "facility_manager" ? "facility manager — can act" : "read-only — can look"}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-destructive" disabled={remove.isPending} onClick={() => remove.mutate({ siteId, memberId: m.id })}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Gap-9: optional organizational layer — group sites under a household/company/
 *  property owner. Nothing is required: sites work fine unattached, and deleting
 *  a group detaches its sites without deleting any data. */
function EntityManager() {
  const utils = trpc.useUtils();
  const entities = trpc.entities.list.useQuery();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"household" | "company" | "property_owner" | "other">("household");
  const create = trpc.entities.create.useMutation({
    onSuccess: async () => {
      toast.success("Group created");
      setName("");
      await utils.entities.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.entities.delete.useMutation({
    onSuccess: async () => {
      toast.success("Group deleted — its sites were detached, not deleted");
      await Promise.all([utils.entities.list.invalidate(), utils.sites.list.invalidate()]);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Card className="mt-6 border-border/70">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-display text-base">
          <FolderKanban className="h-4 w-4 text-primary" /> Owners & organizations
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          Optional: group sites under a household, company, or property owner — one owner can hold many sites, each with
          many meters. Combined figures live on the{" "}
          <a href="/app/portfolio" className="text-primary underline">
            Portfolio
          </a>{" "}
          page.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {(entities.data ?? []).map((en) => (
            <span key={en.id} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/60 px-2.5 py-1 text-xs">
              <FolderKanban className="h-3 w-3 text-primary" /> {en.name}
              <Badge variant="secondary" className="text-[9px]">{en.kind.replace(/_/g, " ")}</Badge>
              <button
                type="button"
                className="text-muted-foreground transition-colors hover:text-destructive"
                title="Delete group (its sites are detached, never deleted)"
                onClick={() => del.mutate({ entityId: en.id })}
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </span>
          ))}
          {!entities.isLoading && (entities.data ?? []).length === 0 && (
            <span className="text-xs text-muted-foreground">No groups yet.</span>
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Input placeholder="e.g. Acme Properties LLC" className="w-56" value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="household">Household</SelectItem>
              <SelectItem value="company">Company</SelectItem>
              <SelectItem value="property_owner">Property owner</SelectItem>
              <SelectItem value="other">Other</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" disabled={!name.trim() || create.isPending} onClick={() => create.mutate({ name: name.trim(), kind })}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add group
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/** Per-site owner-group assignment (stops propagation so the card click
 *  doesn't navigate while picking). Hidden until at least one group exists. */
function SiteEntityPicker({ siteId, entityId }: { siteId: number; entityId: number | null }) {
  const utils = trpc.useUtils();
  const entities = trpc.entities.list.useQuery();
  const assign = trpc.entities.assignSite.useMutation({
    onSuccess: async () => {
      toast.success("Owner group updated");
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  if ((entities.data ?? []).length === 0) return null;
  return (
    <div className="mt-3" onClick={(e) => e.stopPropagation()}>
      <Select
        value={entityId != null ? String(entityId) : "none"}
        onValueChange={(v) => assign.mutate({ siteId, entityId: v === "none" ? null : Number(v) })}
      >
        <SelectTrigger className="h-7 w-52 text-xs">
          <SelectValue placeholder="Owner / group…" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="none">No owner group</SelectItem>
          {(entities.data ?? []).map((en) => (
            <SelectItem key={en.id} value={String(en.id)}>
              {en.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Per-site actions: rename/edit, delete (with cascade warning), manage meters. */
function SiteActions({ site }: { site: { id: number; name: string; address?: string | null; city?: string | null; occupancyHours?: unknown; utilityName?: string | null } }) {
  const utils = trpc.useUtils();
  const [editOpen, setEditOpen] = useState(false);
  const [metersOpen, setMetersOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [form, setForm] = useState({
    name: site.name,
    address: site.address ?? "",
    city: site.city ?? "",
    occupancyHours: typeof site.occupancyHours === "string" ? site.occupancyHours : "",
    utilityName: site.utilityName ?? "",
  });

  const update = trpc.sites.update.useMutation({
    onSuccess: async () => {
      toast.success("Site updated");
      setEditOpen(false);
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.sites.delete.useMutation({
    onSuccess: async () => {
      toast.success("Site deleted — its meters, data, and analyses were removed");
      await utils.sites.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Site actions">
            <MoreVertical className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onClick={() => {
              setForm({ name: site.name, address: site.address ?? "", city: site.city ?? "", occupancyHours: typeof site.occupancyHours === "string" ? site.occupancyHours : "", utilityName: site.utilityName ?? "" });
              setEditOpen(true);
            }}
          >
            <Pencil className="mr-2 h-3.5 w-3.5" /> Edit site
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setMetersOpen(true)}>
            <Zap className="mr-2 h-3.5 w-3.5" /> Manage meters
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setShareOpen(true)}>
            <Users className="mr-2 h-3.5 w-3.5" /> Share access…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setConfirmDelete(true)}>
            <Trash2 className="mr-2 h-3.5 w-3.5" /> Delete site…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {shareOpen && <SharePanel siteId={site.id} open={shareOpen} onClose={() => setShareOpen(false)} />}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display">Edit site</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="e-name">Name</Label>
              <Input id="e-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="e-addr">Address</Label>
              <Input id="e-addr" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="e-city">City</Label>
                <Input id="e-city" value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="e-occ">Occupancy hours</Label>
                <Input id="e-occ" placeholder="e.g. 8-18 weekdays" value={form.occupancyHours} onChange={(e) => setForm({ ...form, occupancyHours: e.target.value })} />
              </div>
            </div>
            <div>
              <Label htmlFor="e-util">Utility</Label>
              <Input id="e-util" value={form.utilityName} onChange={(e) => setForm({ ...form, utilityName: e.target.value })} />
            </div>
            <p className="text-xs text-muted-foreground">
              Building type, size, and year built are refined from the site's Dashboard — they feed the analysis cascade and carry provenance.
            </p>
            <Button
              disabled={!form.name.trim() || update.isPending}
              onClick={() =>
                update.mutate({
                  siteId: site.id,
                  name: form.name.trim(),
                  address: form.address.trim() || null,
                  city: form.city.trim() || null,
                  occupancyHours: form.occupancyHours.trim() || null,
                  utilityName: form.utilityName.trim() || null,
                })
              }
            >
              {update.isPending ? "Saving…" : "Save changes"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={metersOpen} onOpenChange={setMetersOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="font-display">Meters — {site.name}</DialogTitle>
          </DialogHeader>
          <MeterManager siteId={site.id} />
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{site.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the site and everything under it: meters, interval data, bills, analyses, insights, and scenarios. Uploaded files stay in your upload history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => del.mutate({ siteId: site.id })}>
              {del.isPending ? "Deleting…" : "Delete site"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const METER_ROLES = [
  ["main", "Main"],
  ["submeter", "Submeter"],
  ["generation", "Generation"],
  ["ev", "EV charging"],
] as const;

/** Full meter CRUD inside the site's meter dialog: add, rename, set role/parent, delete. */
function MeterManager({ siteId }: { siteId: number }) {
  const utils = trpc.useUtils();
  const meters = trpc.sites.meters.useQuery({ siteId });
  const [newLabel, setNewLabel] = useState("");
  const [newCommodity, setNewCommodity] = useState<"electric" | "gas" | "water">("electric");

  const refresh = async () => {
    await utils.sites.meters.invalidate({ siteId });
  };
  const create = trpc.sites.createMeter.useMutation({
    onSuccess: async () => {
      toast.success("Meter added");
      setNewLabel("");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.sites.updateMeter.useMutation({
    onSuccess: refresh,
    onError: (e) => toast.error(e.message),
  });
  const setRole = trpc.sites.setMeterRole.useMutation({
    onSuccess: async () => {
      toast.success("Meter role updated");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });
  const del = trpc.sites.deleteMeter.useMutation({
    onSuccess: async () => {
      toast.success("Meter deleted — its readings and bills were removed");
      await refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const mains = (meters.data ?? []).filter((m) => m.meterRole === "main");

  return (
    <div className="grid gap-3">
      {(meters.data ?? []).length === 0 && (
        <p className="text-sm text-muted-foreground">No meters yet — add one below, or upload interval data and a meter is created automatically.</p>
      )}
      {(meters.data ?? []).map((m) => (
        <div key={m.id} className="rounded-lg border border-border/70 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Zap className="h-3.5 w-3.5 text-primary" />
            <Input
              className="h-7 w-40 text-xs"
              defaultValue={m.label ?? ""}
              placeholder="Label"
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v !== (m.label ?? "")) update.mutate({ meterId: m.id, label: v || null });
              }}
            />
            <Badge variant="secondary" className="text-[10px]">{m.commodity}</Badge>
            <Select
              value={m.meterRole}
              onValueChange={(role) =>
                setRole.mutate({
                  meterId: m.id,
                  role: role as "main" | "submeter" | "generation" | "ev",
                  parentMeterId: role === "submeter" ? (mains.find((p) => p.id !== m.id)?.id ?? null) : null,
                })
              }
            >
              <SelectTrigger className="h-7 w-32 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METER_ROLES.map(([v, l]) => (
                  <SelectItem key={v} value={v}>
                    {l}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <button
              type="button"
              className="ml-auto text-muted-foreground transition-colors hover:text-destructive"
              title="Delete meter (removes its readings and bills)"
              onClick={() => {
                if (window.confirm(`Delete meter “${m.label ?? m.id}”? Its interval readings and bills are removed. This cannot be undone.`)) {
                  del.mutate({ meterId: m.id });
                }
              }}
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
          {m.meterRole === "submeter" && m.parentMeterId != null && (
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              Nested under meter #{m.parentMeterId} — excluded from site totals to avoid double-counting.
            </p>
          )}
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
        <Input className="h-8 w-44 text-xs" placeholder="New meter label" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
        <Select value={newCommodity} onValueChange={(v) => setNewCommodity(v as typeof newCommodity)}>
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="electric">Electric</SelectItem>
            <SelectItem value="gas">Gas</SelectItem>
            <SelectItem value="water">Water</SelectItem>
          </SelectContent>
        </Select>
        <Button size="sm" className="h-8" disabled={create.isPending} onClick={() => create.mutate({ siteId, label: newLabel.trim() || undefined, commodity: newCommodity })}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Add meter
        </Button>
      </div>
    </div>
  );
}

function SiteMeters({ siteId, state }: { siteId: number; state?: string | null }) {
  const meters = trpc.sites.meters.useQuery({ siteId });
  // §3i-2: per-commodity "rates loaded" registry line under the meter chips —
  // only for commodities this site actually has meters on.
  const reg = trpc.tariffs.utilitiesForState.useQuery({ state: state ?? "" }, { enabled: !!state, staleTime: 5 * 60 * 1000 });
  if (!meters.data || meters.data.length === 0) return null;
  const commodities = Array.from(new Set(meters.data.map((m) => m.commodity)));
  const regParts =
    reg.data && reg.data.rateCount > 0
      ? commodities
          .map((c) => {
            const providers = reg.data![c as "electric" | "gas" | "water"] ?? [];
            return providers.length > 0 ? `${providers.join(" / ")} (${c})` : null;
          })
          .filter((p): p is string => p != null)
      : [];
  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-1.5">
        {meters.data.map((m) => (
          <span key={m.id} className="inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            <Zap className="h-3 w-3 text-primary" /> {m.label ?? `meter ${m.id}`} · {m.commodity} · {m.meterRole}
          </span>
        ))}
      </div>
      {regParts.length > 0 && (
        <p className="mt-1 text-[10px] text-muted-foreground">Rates loaded: {regParts.join(" · ")} — confirm your actual provider on your bill.</p>
      )}
    </div>
  );
}
