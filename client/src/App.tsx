import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import { lazyPage } from "./lib/lazyPage";
// Oct 26 (OPEN-6): the console and secondary public pages load on first use;
// the landing page stays in the main bundle for a fast first paint.
const AppShell = lazyPage(() => import("./pages/AppShell"));
const Convergence = lazyPage(() => import("./pages/Convergence"));
const Legal = lazyPage(() => import("./pages/Legal"));
const Verify = lazyPage(() => import("./pages/Verify"));

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/convergence"} component={Convergence} />
      <Route path={"/legal"} component={Legal} />
      <Route path={"/verify/:token"} component={Verify} />
      <Route path={"/app"} component={AppShell} />
      <Route path={"/app/:rest*"} component={AppShell} />
      <Route path={"/404"} component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
