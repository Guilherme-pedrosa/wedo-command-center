import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { CreditCard, Search, RefreshCw } from "lucide-react";

export default function Pagamentos() {
  const [search, setSearch] = useState("");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Contas a Pagar</h1>
          <p className="text-sm text-muted-foreground">Lançamentos a pagar importados do GestãoClick</p>
        </div>
        <Button size="sm" variant="outline">
          <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
          Importar do GC
        </Button>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input placeholder="Buscar fornecedor..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Código</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Pago</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={6} className="p-0">
                  <EmptyState
                    icon={CreditCard}
                    title="Nenhum pagamento"
                    description="Importe os pagamentos do GestãoClick para visualizar."
                    action={{ label: "Importar agora", onClick: () => {} }}
                  />
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
