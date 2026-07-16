/**
 * Authenticated console shell — DashboardLayout sidebar navigation
 * (handoff §10: dashboard must use DashboardLayout sidebar).
 * Menu items are defined inside DashboardLayout.tsx.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Route, Switch } from "wouter";
import Dashboard from "./console/Dashboard";
import Sites from "./console/Sites";
import Upload from "./console/Upload";
import Wizard from "./console/Wizard";
import Scenarios from "./console/Scenarios";
import Tariffs from "./console/Tariffs";
import Account from "./console/Account";
import ConvergencePanel from "./console/ConvergencePanel";

export default function AppShell() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/app" component={Dashboard} />
        <Route path="/app/sites" component={Sites} />
        <Route path="/app/upload" component={Upload} />
        <Route path="/app/wizard" component={Wizard} />
        <Route path="/app/scenarios" component={Scenarios} />
        <Route path="/app/tariffs" component={Tariffs} />
        <Route path="/app/convergence" component={ConvergencePanel} />
        <Route path="/app/account" component={Account} />
        <Route component={Dashboard} />
      </Switch>
    </DashboardLayout>
  );
}
