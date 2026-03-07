import { Toaster } from "react-hot-toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
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
          </Route>
          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
