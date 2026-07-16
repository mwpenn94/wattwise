/**
 * UHOP convergence log — public transparency page (handoff §10).
 * Shows the recursive review cycles applied to the spec + build, and the
 * seeded reference-data provenance.
 */
import { trpc } from "@/lib/trpc";
import { Link } from "wouter";
import { ArrowLeft, GitBranch, Database } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export default function Convergence() {
  const log = trpc.reference.convergenceLog.useQuery();
  const seeders = trpc.reference.seederRuns.useQuery();

  return (
    <div className="dark min-h-screen bg-background text-foreground">
      <div className="min-h-screen grid-texture">
        <header className="border-b border-border/60">
          <div className="container flex h-14 items-center gap-3">
            <Link href="/" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-4 w-4" /> WattWise
            </Link>
            <span className="font-mono text-xs uppercase tracking-widest text-muted-foreground">/ methodology & convergence log</span>
          </div>
        </header>

        <main className="container max-w-4xl py-10">
          <h1 className="font-display text-3xl font-bold tracking-tight">Convergence log</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            WattWise's specification and build were reviewed by a recursive, fresh-context expert protocol (UHOP). Every cycle
            below records confirmed-material findings that were integrated before the next review pass. Reference data
            provenance is listed underneath — every seeded dataset carries a source, version, and checksum.
          </p>

          <Card className="mt-8 border-border/70">
            <CardHeader className="flex flex-row items-center gap-2">
              <GitBranch className="h-4 w-4 text-primary" />
              <CardTitle className="font-display text-base">Review cycles</CardTitle>
            </CardHeader>
            <CardContent>
              {log.isLoading ? (
                <div className="space-y-2">
                  <Skeleton className="h-16 w-full" />
                  <Skeleton className="h-16 w-full" />
                </div>
              ) : (
                <ol className="relative space-y-6 border-l border-border pl-5">
                  {(log.data ?? []).map((c) => (
                    <li key={c.id} className="relative">
                      <span className="absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full bg-primary" />
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs font-semibold text-primary">{c.cycle}</span>
                        <Badge variant="outline" className="font-mono text-[10px]">{c.phase}</Badge>
                        <span className="text-xs text-muted-foreground">{new Date(c.createdAt).toLocaleDateString()}</span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.summary}</p>
                    </li>
                  ))}
                  {(log.data ?? []).length === 0 && <p className="text-sm text-muted-foreground">No entries recorded yet.</p>}
                </ol>
              )}
            </CardContent>
          </Card>

          <Card className="mt-6 border-border/70">
            <CardHeader className="flex flex-row items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <CardTitle className="font-display text-base">Seeded reference data provenance</CardTitle>
            </CardHeader>
            <CardContent>
              {seeders.isLoading ? (
                <Skeleton className="h-24 w-full" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="font-mono text-xs">Seeder</TableHead>
                      <TableHead className="font-mono text-xs">Version</TableHead>
                      <TableHead className="font-mono text-xs">Rows</TableHead>
                      <TableHead className="font-mono text-xs">Source</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(seeders.data ?? []).map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="font-mono text-xs">{s.seeder}</TableCell>
                        <TableCell className="font-mono text-xs">{s.version}</TableCell>
                        <TableCell className="font-mono text-xs">{s.rowsSeeded}</TableCell>
                        <TableCell className="max-w-md text-xs text-muted-foreground">{s.license}{s.notes ? ` — ${s.notes}` : ""}</TableCell>
                      </TableRow>
                    ))}
                    {(seeders.data ?? []).length === 0 && (
                      <TableRow>
                        <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                          Seeders run on first analysis.
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
