/**
 * UHOP convergence log — in-app transparency panel (handoff §10).
 * Shows optimization cycles, pass counts, clean streaks, and seeded dataset
 * provenance/licenses.
 */
import { trpc } from "@/lib/trpc";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { GitBranch, Database } from "lucide-react";

export default function ConvergencePanel() {
  const log = trpc.reference.convergenceLog.useQuery();
  const seeders = trpc.reference.seederRuns.useQuery();

  return (
    <div className="container max-w-5xl py-8">
      <h1 className="font-display text-2xl font-bold tracking-tight">Convergence log</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        WattWise is built under the Universal Holistic Optimization Protocol: recursive expert review with fresh-context
        passes until a clean streak confirms convergence. This log is public and updated every cycle.
      </p>

      <Card className="mt-6 border-border/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <GitBranch className="h-4 w-4 text-primary" /> Optimization cycles
          </CardTitle>
        </CardHeader>
        <CardContent>
          {log.isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="font-mono text-xs">Cycle</TableHead>
                  <TableHead className="font-mono text-xs">Phase</TableHead>
                  <TableHead className="font-mono text-xs">Summary</TableHead>
                  <TableHead className="text-right font-mono text-xs">Passes</TableHead>
                  <TableHead className="text-right font-mono text-xs">Clean streak</TableHead>
                  <TableHead className="text-right font-mono text-xs">Findings</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(log.data ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono text-xs">{c.cycle}</TableCell>
                    <TableCell className="text-xs">{c.phase}</TableCell>
                    <TableCell className="max-w-md text-xs text-muted-foreground">{c.summary}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{c.passes}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{c.cleanStreak}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{c.materialFindings}</TableCell>
                  </TableRow>
                ))}
                {(log.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No cycles recorded yet.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4 border-border/70">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 font-display text-base">
            <Database className="h-4 w-4 text-primary" /> Seeded datasets & licenses
          </CardTitle>
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
                  <TableHead className="font-mono text-xs">License</TableHead>
                  <TableHead className="font-mono text-xs">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(seeders.data ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-mono text-xs">{s.seeder}</TableCell>
                    <TableCell className="font-mono text-xs">{s.version}</TableCell>
                    <TableCell className="font-mono text-xs">{s.rowsSeeded}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.license}</TableCell>
                    <TableCell className="text-xs">{s.status}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
