import { StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import {
  Receipt, Layers, AlertTriangle, CheckCircle, CreditCard, RefreshCw,
  TrendingUp, Database
} from "lucide-react";

export default function Dashboard() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Visão geral do WeDo Hub</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Sincronizar GC
          </Button>
          <Button variant="outline" size="sm">
            <Database className="h-3.5 w-3.5 mr-1.5" />
            Atualizar Índice OS
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard title="A Receber" value={0} count={0} icon={Receipt} color="blue" />
        <StatCard title="Agrupado" value={0} count={0} icon={Layers} color="orange" />
        <StatCard title="Vencido" value={0} count={0} icon={AlertTriangle} color="red" />
        <StatCard title="Recebido (mês)" value={0} count={0} icon={CheckCircle} color="green" />
        <StatCard title="A Pagar (7d)" value={0} count={0} icon={CreditCard} color="purple" />
        <StatCard title="Pago (mês)" value={0} count={0} icon={TrendingUp} color="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Recebimentos por Cliente (Top 10)</h3>
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            Sincronize os dados do GestãoClick para visualizar
          </div>
        </div>
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Recebimentos por Mês</h3>
          <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
            Sincronize os dados do GestãoClick para visualizar
          </div>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">⚠️ Alertas</h3>
        <p className="text-sm text-muted-foreground">
          Configure a API do GestãoClick em Configurações para ativar os alertas.
        </p>
      </div>
    </div>
  );
}
