/**
 * Authenticated console shell — DashboardLayout sidebar navigation
 * (handoff §10: dashboard must use DashboardLayout sidebar).
 * Menu items are defined inside DashboardLayout.tsx.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Route, Switch } from "wouter";
import Dashboard from "./console/Dashboard";
import HomeFeed from "./console/HomeFeed";
import Sites from "./console/Sites";
import Portfolio from "./console/Portfolio";
import Upload from "./console/Upload";
import Wizard from "./console/Wizard";
import Scenarios from "./console/Scenarios";
import Tariffs from "./console/Tariffs";
import Telecom from "./console/Telecom";
import Account from "./console/Account";
import Reports from "./console/Reports";
import ConvergencePanel from "./console/ConvergencePanel";

export default function AppShell() {
  return (
    <DashboardLayout>
      <Switch>
        <Route path="/app" component={HomeFeed} />
        <Route path="/app/explore" component={Dashboard} />
        <Route path="/app/sites" component={Sites} />
        <Route path="/app/portfolio" component={Portfolio} />
        <Route path="/app/upload" component={Upload} />
        <Route path="/app/wizard" component={Wizard} />
        <Route path="/app/scenarios" component={Scenarios} />
        <Route path="/app/tariffs" component={Tariffs} />
        <Route path="/app/telecom" component={Telecom} />
        <Route path="/app/reports" component={Reports} />
        <Route path="/app/convergence" component={ConvergencePanel} />
        <Route path="/app/account" component={Account} />
        <Route component={HomeFeed} />
      </Switch>
    </DashboardLayout>
  );
}
