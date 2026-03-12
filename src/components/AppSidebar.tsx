import {
  LayoutDashboard, ShoppingCart, DollarSign, Receipt,
  Layers, CreditCard, CalendarClock, ScrollText, Settings,
  ChevronDown, TrendingUp, Building2, ArrowLeftRight, FileText,
  BarChart3, LineChart, BookOpen, Landmark, Search, Users, Building, Tv,
} from "lucide-react";
import { NavLink } from "@/components/NavLink";
import { useLocation } from "react-router-dom";
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent,
  SidebarGroupLabel, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarHeader, SidebarFooter, useSidebar,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

const mainItems = [
  { title: "Dashboard", url: "/", icon: LayoutDashboard },
  { title: "Picking", url: "/picking", icon: ShoppingCart },
];

const oldFinanceItems = [
  { title: "Recebimentos", url: "/recebimentos", icon: Receipt },
  { title: "Grupos", url: "/grupos", icon: Layers },
];

const oldPayItems = [
  { title: "A Pagar", url: "/pagamentos", icon: CreditCard },
  { title: "Agendamentos", url: "/agendamentos", icon: CalendarClock },
];

const finLancamentos = [
  { title: "📊 Dashboard", url: "/financeiro/dashboard", icon: LayoutDashboard },
  { title: "💰 A Receber", url: "/financeiro/recebimentos", icon: Receipt },
  { title: "💸 A Pagar", url: "/financeiro/pagamentos", icon: CreditCard },
];

const finCadastros = [
  { title: "👥 Clientes", url: "/financeiro/clientes", icon: Users },
  { title: "🏢 Fornecedores", url: "/financeiro/fornecedores", icon: Building },
];

const finGrupos = [
  { title: "🗂️ Grupos Receber", url: "/financeiro/grupos-receber", icon: Layers },
  { title: "🗂️ Grupos Pagar", url: "/financeiro/grupos-pagar", icon: Layers },
  { title: "🤝 Negociação OS", url: "/financeiro/negociacao-os", icon: Layers },
  { title: "📋 Negociações", url: "/financeiro/negociacoes", icon: Layers },
];

const finBanco = [
  { title: "📅 Agenda Pgto", url: "/financeiro/agenda", icon: CalendarClock },
  { title: "💳 Fatura Cartão", url: "/financeiro/fatura-cartao", icon: CreditCard },
  { title: "🏦 Extrato & Conciliação", url: "/financeiro/extrato", icon: Building2 },
  { title: "✅ Histórico Conc.", url: "/financeiro/conciliacao-historico", icon: FileText },
];

const finRelatorios = [
  { title: "📈 DRE", url: "/financeiro/dre", icon: BarChart3 },
  { title: "📉 Fluxo Caixa", url: "/financeiro/fluxo-caixa", icon: LineChart },
  { title: "🎯 Resultados Operação", url: "/financeiro/metas", icon: FileText },
  { title: "🧮 Precificação", url: "/financeiro/precificacao", icon: BarChart3 },
];

const finAdmin = [
  { title: "\uD83D\uDCCB Plano Contas", url: "/financeiro/plano-contas", icon: BookOpen },
  { title: "\uD83C\uDFE2 Centros de Custo", url: "/financeiro/centros-custo", icon: BookOpen },
  { title: "📺 Painéis TV", url: "/financeiro/paineis-tv", icon: Tv },
  { title: "\u2699\uFE0F Config Inter", url: "/financeiro/config-banco", icon: Landmark },
  { title: "\uD83D\uDD0D Log API", url: "/financeiro/log", icon: Search },
];

const bottomItems = [
  { title: "Log", url: "/log", icon: ScrollText },
  { title: "Configurações", url: "/configuracoes", icon: Settings },
];

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const location = useLocation();
  const isActive = (path: string) => location.pathname === path;
  const finOpen = location.pathname.startsWith("/financeiro");

  const renderItems = (items: typeof mainItems) =>
    items.map((item) => (
      <SidebarMenuItem key={item.title}>
        <SidebarMenuButton asChild>
          <NavLink to={item.url} end className="hover:bg-accent/50" activeClassName="bg-accent text-primary font-medium">
            <item.icon className="mr-2 h-4 w-4 shrink-0" />
            {!collapsed && <span>{item.title}</span>}
          </NavLink>
        </SidebarMenuButton>
      </SidebarMenuItem>
    ));

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader className="p-4">
        {!collapsed && (
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm">A</div>
            <div>
              <h2 className="text-sm font-bold text-foreground">ARGUS</h2>
              <p className="text-[10px] text-muted-foreground">Gestão Operacional</p>
            </div>
          </div>
        )}
        {collapsed && (
          <div className="h-8 w-8 rounded-md bg-primary flex items-center justify-center text-primary-foreground font-bold text-sm mx-auto">W</div>
        )}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(mainItems)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {!collapsed && (
          <>
            {/* Old finance sections */}
            <SidebarGroup>
              <Collapsible defaultOpen={false}>
                <CollapsibleTrigger className="flex items-center w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
                  <DollarSign className="h-3 w-3 mr-1.5" />
                  Legado
                  <ChevronDown className="ml-auto h-3 w-3" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {renderItems(oldFinanceItems)}
                      {renderItems(oldPayItems)}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </Collapsible>
            </SidebarGroup>

            {/* New Financeiro Hub */}
            <SidebarGroup>
              <Collapsible defaultOpen={finOpen}>
                <CollapsibleTrigger className="flex items-center w-full px-3 py-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground">
                  <TrendingUp className="h-3 w-3 mr-1.5" />
                  Financeiro Hub
                  <ChevronDown className="ml-auto h-3 w-3" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {renderItems(finLancamentos)}
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground/60">Cadastros</div>
                      {renderItems(finCadastros)}
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground/60">Grupos</div>
                      {renderItems(finGrupos)}
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground/60">Banco</div>
                      {renderItems(finBanco)}
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground/60">Relatórios</div>
                      {renderItems(finRelatorios)}
                      <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase text-muted-foreground/60">Admin</div>
                      {renderItems(finAdmin)}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </CollapsibleContent>
              </Collapsible>
            </SidebarGroup>
          </>
        )}

        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>{renderItems(bottomItems)}</SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        {!collapsed && (
          <div className="space-y-1.5 text-[10px]">
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground">GC: Não configurado</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
              <span className="text-muted-foreground">Inter: Não configurado</span>
            </div>
          </div>
        )}
      </SidebarFooter>
    </Sidebar>
  );
}
