import { useAuth } from "@/_core/hooks/useAuth";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import AlertsInbox from "@/components/AlertsInbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { startLogin } from "@/const";
import { useIsMobile } from "@/hooks/useMobile";
import {
  Building2,
  FileUp,
  GitBranch,
  LayoutDashboard,
  LogOut,
  FolderKanban,
  PanelLeft,
  Receipt,
  Settings,
  Sparkles,
  Sun,
  Zap,
  Home as HomeIcon,
  FileText,
} from "lucide-react";
import { CSSProperties, useEffect, useRef, useState } from "react";
import { useLang } from "@/lib/i18n";
import { useLocation } from "wouter";
import { DashboardLayoutSkeleton } from './DashboardLayoutSkeleton';
import { Button } from "./ui/button";

const menuItems = [
  { icon: HomeIcon, label: "Home", path: "/app" },
  { icon: LayoutDashboard, label: "Explore", path: "/app/explore" },
  { icon: Building2, label: "Sites", path: "/app/sites" },
  { icon: FolderKanban, label: "Portfolio", path: "/app/portfolio" },
  { icon: FileUp, label: "Upload data", path: "/app/upload" },
  { icon: Sparkles, label: "Hypothetical building", path: "/app/wizard" },
  { icon: Sun, label: "Scenarios", path: "/app/scenarios" },
  { icon: Receipt, label: "Tariffs", path: "/app/tariffs" },
  { icon: FileText, label: "Reports", path: "/app/reports" },
  { icon: GitBranch, label: "Convergence log", path: "/app/convergence" },
  { icon: Settings, label: "Account & usage", path: "/app/account" },
];

const SIDEBAR_WIDTH_KEY = "sidebar-width";
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 480;

/**
 * I18N-2 — Spanish-preference console tip. The hand-crafted ES table covers
 * the public funnel; console/analysis surfaces rely on browser-native
 * translation (Chrome/Edge/Safari). When the user's language preference is
 * Spanish, show a one-time dismissible banner telling them how to use it.
 */
const ES_TIP_DISMISS_KEY = "meterly.esTranslateTip.dismissed";
function EsTranslateTip() {
  const { lang, t } = useLang();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(ES_TIP_DISMISS_KEY) === "1";
    } catch {
      return true;
    }
  });
  if (lang !== "es" || dismissed) return null;
  return (
    <div className="mx-4 mt-3 flex items-start justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 px-3 py-2 pr-14 text-xs text-muted-foreground md:mr-16">
      <span>{t("lang.consoleNote")}</span>
      <button
        className="shrink-0 font-mono text-[11px] text-primary hover:underline"
        onClick={() => {
          setDismissed(true);
          try {
            localStorage.setItem(ES_TIP_DISMISS_KEY, "1");
          } catch {
            /* ignore */
          }
        }}
        aria-label="Dismiss translation tip"
      >
        OK
      </button>
    </div>
  );
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const { loading, user } = useAuth();

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString());
  }, [sidebarWidth]);

  if (loading) {
    return <DashboardLayoutSkeleton />
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-8 p-8 max-w-md w-full">
          <div className="flex flex-col items-center gap-6">
            <h1 className="text-2xl font-semibold tracking-tight text-center">
              Sign in to continue
            </h1>
            <p className="text-sm text-muted-foreground text-center max-w-sm">
              Access to this dashboard requires authentication. Continue to launch the login flow.
            </p>
          </div>
          <Button
            onClick={() => startLogin()}
            size="lg"
            className="w-full shadow-lg hover:shadow-xl transition-all"
          >
            Sign in
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": `${sidebarWidth}px`,
        } as CSSProperties
      }
    >
      <DashboardLayoutContent setSidebarWidth={setSidebarWidth}>
        {children}
      </DashboardLayoutContent>
    </SidebarProvider>
  );
}

type DashboardLayoutContentProps = {
  children: React.ReactNode;
  setSidebarWidth: (width: number) => void;
};

function DashboardLayoutContent({
  children,
  setSidebarWidth,
}: DashboardLayoutContentProps) {
  const { user, logout } = useAuth();
  const [location, setLocation] = useLocation();
  const { state, toggleSidebar } = useSidebar();
  const isCollapsed = state === "collapsed";
  const [isResizing, setIsResizing] = useState(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const activeMenuItem = menuItems.find(item => item.path === location);
  const isMobile = useIsMobile();

  useEffect(() => {
    if (isCollapsed) {
      setIsResizing(false);
    }
  }, [isCollapsed]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;

      const sidebarLeft = sidebarRef.current?.getBoundingClientRect().left ?? 0;
      const newWidth = e.clientX - sidebarLeft;
      if (newWidth >= MIN_WIDTH && newWidth <= MAX_WIDTH) {
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [isResizing, setSidebarWidth]);

  return (
    <>
      <div className="relative" ref={sidebarRef}>
        <Sidebar
          collapsible="icon"
          className="border-r-0"
          disableTransition={isResizing}
        >
          <SidebarHeader className="h-16 justify-center">
            <div className="flex items-center gap-3 px-2 transition-all w-full">
              <button
                onClick={toggleSidebar}
                className="h-8 w-8 flex items-center justify-center hover:bg-accent rounded-lg transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring shrink-0"
                aria-label="Toggle navigation"
              >
                <PanelLeft className="h-4 w-4 text-muted-foreground" />
              </button>
              {!isCollapsed ? (
                <button
                  onClick={() => setLocation("/")}
                  className="flex items-center gap-2 min-w-0 rounded-md px-1 py-0.5 transition-colors hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  title="Back to public site"
                  aria-label="Back to public site"
                >
                  <div className="flex h-6 w-6 items-center justify-center rounded bg-primary text-primary-foreground shrink-0">
                    <Zap className="h-4 w-4" />
                  </div>
                  <span translate="no" className="font-semibold tracking-tight truncate font-display">
                    Meterly
                  </span>
                </button>
              ) : null}
            </div>
          </SidebarHeader>

          <SidebarContent className="gap-0">
            <SidebarMenu className="px-2 py-1">
              {menuItems.map(item => {
                const isActive =
                  item.path === "/app"
                    ? location === "/app"
                    : location.startsWith(item.path);
                return (
                  <SidebarMenuItem key={item.path}>
                    <SidebarMenuButton
                      isActive={isActive}
                      onClick={() => setLocation(item.path)}
                      tooltip={item.label}
                      className={`h-10 transition-all font-normal`}
                    >
                      <item.icon
                        className={`h-4 w-4 ${isActive ? "text-primary" : ""}`}
                      />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarContent>

          <SidebarFooter className="p-3">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 rounded-lg px-1 py-1 hover:bg-accent/50 transition-colors w-full text-left group-data-[collapsible=icon]:justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Avatar className="h-9 w-9 border shrink-0">
                    <AvatarFallback className="text-xs font-medium">
                      {user?.name?.charAt(0).toUpperCase()}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex-1 min-w-0 group-data-[collapsible=icon]:hidden">
                    <p className="text-sm font-medium truncate leading-none">
                      {user?.name || "-"}
                    </p>
                    <p className="text-xs text-muted-foreground truncate mt-1.5">
                      {user?.email || "-"}
                    </p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setLocation("/")} className="cursor-pointer">
                  <Zap className="mr-2 h-4 w-4" />
                  <span>Public site</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={logout}
                  className="cursor-pointer text-destructive focus:text-destructive"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarFooter>
        </Sidebar>
        <div
          className={`absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-primary/20 transition-colors ${isCollapsed ? "hidden" : ""}`}
          onMouseDown={() => {
            if (isCollapsed) return;
            setIsResizing(true);
          }}
          style={{ zIndex: 50 }}
        />
      </div>

      <SidebarInset>
        {isMobile && (
          <div className="flex border-b h-14 items-center justify-between bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:backdrop-blur sticky top-0 z-40">
            <div className="flex items-center gap-2">
              <SidebarTrigger className="h-9 w-9 rounded-lg bg-background" />
              <div className="flex items-center gap-3">
                <div className="flex flex-col gap-1">
                  <span className="tracking-tight text-foreground">
                    {activeMenuItem?.label ?? "Menu"}
                  </span>
                </div>
              </div>
            </div>
            <AlertsInbox />
          </div>
        )}
        {!isMobile && (
          <div className="pointer-events-none sticky top-0 z-40 flex h-0 justify-end">
            <div className="pointer-events-auto mr-4 mt-3">
              <AlertsInbox />
            </div>
          </div>
        )}
        <EsTranslateTip />
        <main className="flex-1 p-4">{children}</main>
        {/* §5c-1b: privacy/terms/contact reachable from every page, console included */}
        <footer className="border-t border-border/60 px-4 py-3">
          <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted-foreground">
            <a href="/legal#privacy" className="hover:text-foreground">Privacy policy</a>
            <a href="/legal#terms" className="hover:text-foreground">Terms of use</a>
            <a href="/legal#contact" className="hover:text-foreground">Contact</a>
            <a href="/convergence" className="hover:text-foreground">Methodology</a>
          </div>
        </footer>
      </SidebarInset>
    </>
  );
}
