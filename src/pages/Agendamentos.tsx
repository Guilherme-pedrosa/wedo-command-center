import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { CalendarClock, Plus } from "lucide-react";

export default function Agendamentos() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agendamentos</h1>
          <p className="text-sm text-muted-foreground">Pagamentos programados via PIX</p>
        </div>
        <Button size="sm">
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Novo Agendamento
        </Button>
      </div>

      <EmptyState
        icon={CalendarClock}
        title="Nenhum agendamento"
        description="Crie agendamentos para programar pagamentos automáticos via PIX pelo Banco Inter."
      />
    </div>
  );
}
