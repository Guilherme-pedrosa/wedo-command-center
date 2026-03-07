import { lazy, Suspense } from "react";
import { Toaster } from "react-hot-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AppLayout } from "@/components/AppLayout";
import { Loader2 } from "lucide-react";
import Dashboard from "@/pages/Dashboard";
import Picking from "@/pages/Picking";
import Recebimentos from "@/pages/Recebimentos";
import Grupos from "@/pages/Grupos";
import Pagamentos from "@/pages/Pagamentos";
import Agendamentos from "@/pages/Agendamentos";
import SyncLog from "@/pages/SyncLog";
import Configuracoes from "@/pages/Configuracoes";
import NotFound from "@/pages/NotFound";

// Financeiro pages (lazy loaded)
const FinDashboard = lazy(() => import("@/pages/financeiro/DashboardPage"));
const FinReceber = lazy(() => import("@/pages/financeiro/RecebimentosPage"));
const FinPagar = lazy(() => import("@/pages/financeiro/PagamentosPage"));
const FinGrpReceber = lazy(() => import("@/pages/financeiro/GruposReceberPage"));
const FinGrpPagar = lazy(() => import("@/pages/financeiro/GruposPagarPage"));
const FinAgenda = lazy(() => import("@/pages/financeiro/AgendaPage"));
const FinExtrato = lazy(() => import("@/pages/financeiro/ExtratoBancoPage"));
const FinConciliacao = lazy(() => import("@/pages/financeiro/ConciliacaoPage"));
const FinDRE = lazy(() => import("@/pages/financeiro/DREPage"));
const FinFluxo = lazy(() => import("@/pages/financeiro/FluxoCaixaPage"));
const FinPlanoContas = lazy(() => import("@/pages/financeiro/PlanoContasPage"));
const FinConfigBanco = lazy(() => import("@/pages/financeiro/ConfigBancoPage"));
const FinLog = lazy(() => import("@/pages/financeiro/LogPage"));

const queryClient = new QueryClient();

function LazyFallback() {
  return (
    <div className="flex items-center justify-center h-64">
      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
    </div>
  );
}

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

            {/* Financeiro Hub */}
            <Route path="/financeiro" element={<Navigate to="/financeiro/dashboard" replace />} />
            <Route path="/financeiro/dashboard" element={<Suspense fallback={<LazyFallback />}><FinDashboard /></Suspense>} />
            <Route path="/financeiro/recebimentos" element={<Suspense fallback={<LazyFallback />}><FinReceber /></Suspense>} />
            <Route path="/financeiro/pagamentos" element={<Suspense fallback={<LazyFallback />}><FinPagar /></Suspense>} />
            <Route path="/financeiro/grupos-receber" element={<Suspense fallback={<LazyFallback />}><FinGrpReceber /></Suspense>} />
            <Route path="/financeiro/grupos-pagar" element={<Suspense fallback={<LazyFallback />}><FinGrpPagar /></Suspense>} />
            <Route path="/financeiro/agenda" element={<Suspense fallback={<LazyFallback />}><FinAgenda /></Suspense>} />
            <Route path="/financeiro/extrato" element={<Suspense fallback={<LazyFallback />}><FinExtrato /></Suspense>} />
            <Route path="/financeiro/conciliacao" element={<Suspense fallback={<LazyFallback />}><FinConciliacao /></Suspense>} />
            <Route path="/financeiro/dre" element={<Suspense fallback={<LazyFallback />}><FinDRE /></Suspense>} />
            <Route path="/financeiro/fluxo-caixa" element={<Suspense fallback={<LazyFallback />}><FinFluxo /></Suspense>} />
            <Route path="/financeiro/plano-contas" element={<Suspense fallback={<LazyFallback />}><FinPlanoContas /></Suspense>} />
            <Route path="/financeiro/config-banco" element={<Suspense fallback={<LazyFallback />}><FinConfigBanco /></Suspense>} />
            <Route path="/financeiro/log" element={<Suspense fallback={<LazyFallback />}><FinLog /></Suspense>} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
