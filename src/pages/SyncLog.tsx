import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/components/EmptyState";
import { ScrollText, Search, Download } from "lucide-react";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

export default function SyncLog() {
  const [search, setSearch] = useState("");
  const [tipo, setTipo] = useState("todos");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Log de Sincronização</h1>
          <p className="text-sm text-muted-foreground">Histórico de todas as operações com APIs externas</p>
        </div>
        <Button size="sm" variant="outline">
          <Download className="h-3.5 w-3.5 mr-1.5" />
          Exportar CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar referência..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipo} onValueChange={setTipo}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Tipo" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="importacao_recebimentos">Importação Recebimentos</SelectItem>
            <SelectItem value="importacao_pagamentos">Importação Pagamentos</SelectItem>
            <SelectItem value="build_os_index">Build OS Index</SelectItem>
            <SelectItem value="baixa_gc_recebimento">Baixa GC Recebimento</SelectItem>
            <SelectItem value="cobranca_inter_pix">Cobrança Inter PIX</SelectItem>
            <SelectItem value="pagamento_inter_pix">Pagamento Inter PIX</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Data/Hora</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Tipo</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Referência</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Duração</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={6} className="p-0">
                  <EmptyState
                    icon={ScrollText}
                    title="Nenhum log registrado"
                    description="Os logs aparecerão conforme as sincronizações forem executadas."
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
