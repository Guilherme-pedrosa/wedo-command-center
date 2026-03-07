import { Toaster } from "react-hot-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import Dashboard from "@/pages/Dashboard";
import Picking from "@/pages/Picking";
import Recebimentos from "@/pages/Recebimentos";
import Grupos from "@/pages/Grupos";
import Pagamentos from "@/pages/Pagamentos";
import Agendamentos from "@/pages/Agendamentos";
import SyncLog from "@/pages/SyncLog";
import Configuracoes from "@/pages/Configuracoes";
import NotFound from "@/pages/NotFound";

// Financeiro pages
import FinDashboard from "@/pages/financeiro/DashboardPage";
import FinReceber from "@/pages/financeiro/RecebimentosPage";
import FinPagar from "@/pages/financeiro/PagamentosPage";
import FinGrpReceber from "@/pages/financeiro/GruposReceberPage";
import FinGrpPagar from "@/pages/financeiro/GruposPagarPage";
import FinAgenda from "@/pages/financeiro/AgendaPage";
import FinExtrato from "@/pages/financeiro/ExtratoBancoPage";
import FinConciliacao from "@/pages/financeiro/ConciliacaoPage";
import FinDRE from "@/pages/financeiro/DREPage";
import FinFluxo from "@/pages/financeiro/FluxoCaixaPage";
import FinPlanoContas from "@/pages/financeiro/PlanoContasPage";
import FinConfigBanco from "@/pages/financeiro/ConfigBancoPage";
import FinLog from "@/pages/financeiro/LogPage";

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: "hsl(217 33% 17%)",
            color: "hsl(210 40% 96%)",
            border: "1px solid hsl(215 28% 25%)",
          },
        }}
      />
      <BrowserRouter>
        <Routes>
          <Route element={<AppLayout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/picking" element={<Picking />} />
            <Route path="/recebimentos" element={<Recebimentos />} />
            <Route path="/grupos" element={<Grupos />} />
            <Route path="/pagamentos" element={<Pagamentos />} />
            <Route path="/agendamentos" element={<Agendamentos />} />
            <Route path="/log" element={<SyncLog />} />
            <Route path="/configuracoes" element={<Configuracoes />} />

            {/* Financeiro */}
            <Route path="/financeiro" element={<Navigate to="/financeiro/dashboard" replace />} />
            <Route path="/financeiro/dashboard" element={<FinDashboard />} />
            <Route path="/financeiro/recebimentos" element={<FinReceber />} />
            <Route path="/financeiro/pagamentos" element={<FinPagar />} />
            <Route path="/financeiro/grupos-receber" element={<FinGrpReceber />} />
            <Route path="/financeiro/grupos-pagar" element={<FinGrpPagar />} />
            <Route path="/financeiro/agenda" element={<FinAgenda />} />
            <Route path="/financeiro/extrato" element={<FinExtrato />} />
            <Route path="/financeiro/conciliacao" element={<FinConciliacao />} />
            <Route path="/financeiro/dre" element={<FinDRE />} />
            <Route path="/financeiro/fluxo-caixa" element={<FinFluxo />} />
            <Route path="/financeiro/plano-contas" element={<FinPlanoContas />} />
            <Route path="/financeiro/config-banco" element={<FinConfigBanco />} />
            <Route path="/financeiro/log" element={<FinLog />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
