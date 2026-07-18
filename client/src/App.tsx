import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import Home from "./pages/Home";
import AppShell from "./pages/AppShell";
import Convergence from "./pages/Convergence";
import Verify from "./pages/Verify";

function Router() {
  return (
    <Switch>
      <Route path={"/"} component={Home} />
      <Route path={"/convergence"} component={Convergence} />
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
      <ThemeProvider defaultTheme="dark">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
