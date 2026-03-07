import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { RefreshCw, ShoppingCart, AlertOctagon, CheckCircle, Search, ChevronDown, ChevronRight } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";

export default function Picking() {
  const [blockedOpen, setBlockedOpen] = useState(true);
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Lista de Compras</h1>
          <p className="text-sm text-muted-foreground">WeDo Picking — detecção automática de orçamentos convertidos</p>
        </div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30">
            0 ativos
          </Badge>
          <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30">
            0 bloqueados
          </Badge>
          <div className="text-xs text-muted-foreground px-2 py-1 bg-muted rounded">
            Índice: não construído
          </div>
          <Button size="sm">
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Atualizar
          </Button>
        </div>
      </div>

      {/* Bloqueados */}
      <Collapsible open={blockedOpen} onOpenChange={setBlockedOpen}>
        <div className="rounded-lg border-l-4 border-wedo-red border border-border bg-card">
          <CollapsibleTrigger className="flex items-center w-full p-4 text-left">
            {blockedOpen ? <ChevronDown className="h-4 w-4 mr-2" /> : <ChevronRight className="h-4 w-4 mr-2" />}
            <AlertOctagon className="h-4 w-4 mr-2 text-wedo-red" />
            <span className="font-semibold text-foreground">Bloqueados</span>
            <span className="text-sm text-muted-foreground ml-2">— já possuem OS ou estão em processamento</span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-4 pb-4">
              <p className="text-sm text-muted-foreground">
                Nenhum orçamento bloqueado. Sincronize os dados para atualizar.
              </p>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>

      {/* Ativos */}
      <div className="rounded-lg border-l-4 border-wedo-green border border-border bg-card">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-4">
            <CheckCircle className="h-4 w-4 text-wedo-green" />
            <span className="font-semibold text-foreground">Ativos</span>
            <span className="text-sm text-muted-foreground">— liberados para compra (0)</span>
          </div>

          <div className="flex items-center gap-3 mb-4">
            <div className="relative flex-1 max-w-sm">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Buscar por cliente..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-9"
              />
            </div>
          </div>

          <EmptyState
            icon={ShoppingCart}
            title="Nenhum orçamento ativo"
            description="Configure a API do GestãoClick e clique em Atualizar para carregar os orçamentos."
            action={{ label: "Ir para Configurações", onClick: () => window.location.href = "/configuracoes" }}
          />
        </div>
      </div>

      <div className="flex items-center justify-between p-4 rounded-lg border border-border bg-card">
        <span className="text-sm font-medium text-foreground">Total a comprar:</span>
        <span className="text-lg font-bold text-wedo-green">R$ 0,00</span>
      </div>
    </div>
  );
}
