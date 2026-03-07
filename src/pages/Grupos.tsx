import { useState } from "react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/EmptyState";
import { StatusBadge } from "@/components/StatusBadge";
import { Layers, LayoutGrid, List, Plus, RefreshCw } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export default function Grupos() {
  const [view, setView] = useState<"cards" | "table">("cards");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Grupos Financeiros</h1>
          <p className="text-sm text-muted-foreground">Agrupamento de recebimentos para cobrança</p>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={view} onValueChange={(v) => setView(v as any)}>
            <TabsList className="h-8">
              <TabsTrigger value="cards" className="h-7 px-2">
                <LayoutGrid className="h-3.5 w-3.5" />
              </TabsTrigger>
              <TabsTrigger value="table" className="h-7 px-2">
                <List className="h-3.5 w-3.5" />
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <Button size="sm" variant="outline">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Atualizar
          </Button>
        </div>
      </div>

      <EmptyState
        icon={Layers}
        title="Nenhum grupo criado"
        description="Selecione recebimentos na página de Recebimentos e crie grupos para cobrança."
        action={{ label: "Ir para Recebimentos", onClick: () => window.location.href = "/recebimentos" }}
      />
    </div>
  );
}
