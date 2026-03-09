import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/AppSidebar";
import { Outlet, Link, useLocation } from "react-router-dom";
import {
  Bell, DollarSign, ChevronDown, LayoutDashboard, Receipt, CreditCard,
  Layers, CalendarClock, Building2, ArrowLeftRight, BarChart3, LineChart,
  BookOpen, Landmark, Search, Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function AppLayout() {
  const location = useLocation();
  const isFinActive = location.pathname.startsWith("/financeiro");

  return (
    <SidebarProvider>
      <div className="min-h-screen flex w-full">
        <AppSidebar />
        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-12 flex items-center justify-between border-b border-border px-4 shrink-0">
            <div className="flex items-center gap-2">
              <SidebarTrigger />

              {/* Financeiro dropdown in header */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                      "h-8 gap-1.5 text-sm font-medium",
                      isFinActive && "bg-accent text-accent-foreground"
                    )}
                  >
                    <DollarSign className="h-3.5 w-3.5" />
                    Financeiro
                    <ChevronDown className="h-3 w-3 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/dashboard" className="flex items-center gap-2">
                      <LayoutDashboard className="h-3.5 w-3.5" /> Dashboard
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/recebimentos" className="flex items-center gap-2">
                      <Receipt className="h-3.5 w-3.5" /> A Receber
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/pagamentos" className="flex items-center gap-2">
                      <CreditCard className="h-3.5 w-3.5" /> A Pagar
                    </Link>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/grupos-receber" className="flex items-center gap-2">
                      <Layers className="h-3.5 w-3.5" /> Grupos Receber
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/grupos-pagar" className="flex items-center gap-2">
                      <Layers className="h-3.5 w-3.5" /> Grupos Pagar
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/agenda" className="flex items-center gap-2">
                      <CalendarClock className="h-3.5 w-3.5" /> Agenda Pagamentos
                    </Link>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/conciliacao" className="flex items-center gap-2">
                      <ArrowLeftRight className="h-3.5 w-3.5" /> Conciliação
                    </Link>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/dre" className="flex items-center gap-2">
                      <BarChart3 className="h-3.5 w-3.5" /> DRE
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/fluxo-caixa" className="flex items-center gap-2">
                      <LineChart className="h-3.5 w-3.5" /> Fluxo de Caixa
                    </Link>
                  </DropdownMenuItem>

                  <DropdownMenuSeparator />

                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/plano-contas" className="flex items-center gap-2">
                      <BookOpen className="h-3.5 w-3.5" /> Plano de Contas
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/config-banco" className="flex items-center gap-2">
                      <Landmark className="h-3.5 w-3.5" /> Config Banco
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/financeiro/log" className="flex items-center gap-2">
                      <Search className="h-3.5 w-3.5" /> Log API
                    </Link>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8 relative">
                <Bell className="h-4 w-4" />
              </Button>
            </div>
          </header>
          <main className="flex-1 overflow-auto p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
