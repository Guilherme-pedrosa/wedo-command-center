import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Receipt, Search, RefreshCw, Plus } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export default function Recebimentos() {
  const [search, setSearch] = useState("");
  const [tipo, setTipo] = useState("todos");
  const [showGrouped, setShowGrouped] = useState(false);
  const [showLiquidated, setShowLiquidated] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recebimentos</h1>
          <p className="text-sm text-muted-foreground">Lançamentos a receber importados do GestãoClick</p>
        </div>
        <Button size="sm" variant="outline">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Importar do GC
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar cliente, descrição..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipo} onValueChange={setTipo}>
          <SelectTrigger className="w-[140px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="os">OS</SelectItem>
            <SelectItem value="venda">Venda</SelectItem>
            <SelectItem value="contrato">Contrato</SelectItem>
            <SelectItem value="outro">Outro</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="grouped" checked={showGrouped} onCheckedChange={setShowGrouped} />
          <Label htmlFor="grouped" className="text-xs text-muted-foreground">Agrupados</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="liquidated" checked={showLiquidated} onCheckedChange={setShowLiquidated} />
          <Label htmlFor="liquidated" className="text-xs text-muted-foreground">Liquidados</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="overdue" checked={overdueOnly} onCheckedChange={setOverdueOnly} />
          <Label htmlFor="overdue" className="text-xs text-muted-foreground">Vencidos</Label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left w-10">
                  <input type="checkbox" className="rounded border-border" />
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Código</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">OS</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cliente</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Grupo</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={8} className="p-0">
                  <EmptyState
                    icon={Receipt}
                    title="Nenhum recebimento"
                    description="Importe os recebimentos do GestãoClick para visualizar aqui."
                    action={{ label: "Importar agora", onClick: () => {} }}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {selected.length > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4 flex items-center justify-between">
          <span className="text-sm text-foreground">{selected.length} selecionados</span>
          <div className="flex gap-2">
            <Button size="sm">
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Criar Grupo
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
