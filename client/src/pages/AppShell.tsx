/**
 * Authenticated console shell — DashboardLayout sidebar navigation
 * (handoff §10: dashboard must use DashboardLayout sidebar).
 * Menu items are defined inside DashboardLayout.tsx.
 */
import DashboardLayout from "@/components/DashboardLayout";
import { Route, Switch, useSearch } from "wouter";
import { Redirect } from "wouter";
import { lazyPage } from "@/lib/lazyPage";
// Oct 26 (OPEN-6): each console page downloads the first time it is opened.
const Dashboard = lazyPage(() => import("./console/Dashboard"));
const HomeFeed = lazyPage(() => import("./console/HomeFeed"));
const Sites = lazyPage(() => import("./console/Sites"));
const Portfolio = lazyPage(() => import("./console/Portfolio"));
const Upload = lazyPage(() => import("./console/Upload"));
const Wizard = lazyPage(() => import("./console/Wizard"));
const Scenarios = lazyPage(() => import("./console/Scenarios"));
const Tariffs = lazyPage(() => import("./console/Tariffs"));
const Account = lazyPage(() => import("./console/Account"));
const Reports = lazyPage(() => import("./console/Reports"));
const ConvergencePanel = lazyPage(() => import("./console/ConvergencePanel"));

function TelecomRedirect() {
  const search = useSearch();
  return <Redirect to={`/app/explore${search ? `?${search}` : ""}`} />;
}

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
        <Route path="/app/telecom" component={TelecomRedirect} />
        <Route path="/app/reports" component={Reports} />
        <Route path="/app/convergence" component={ConvergencePanel} />
        <Route path="/app/account" component={Account} />
        <Route component={HomeFeed} />
      </Switch>
    </DashboardLayout>
  );
}
