import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { CheckCircle, Search } from "lucide-react";

export default function ConciliacaoHistoricoPage() {
  const [search, setSearch] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");

  const { data: items, isLoading } = useQuery({
    queryKey: ["conciliacao-historico"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_extrato_inter")
        .select("id, end_to_end_id, tipo, valor, contrapartida, cpf_cnpj, data_hora, reconciliado_em, lancamento_id, grupo_receber_id, grupo_pagar_id")
        .eq("reconciliado", true)
        .order("reconciliado_em", { ascending: false })
        .limit(200);
      return data || [];
    },
  });

  const filtered = (items || []).filter((i: any) => {
    if (tipoFilter !== "todos" && i.tipo !== tipoFilter) return false;
    if (search) {
      const s = search.toLowerCase();
      return (
        (i.contrapartida ?? "").toLowerCase().includes(s) ||
        (i.cpf_cnpj ?? "").includes(s) ||
        (i.end_to_end_id ?? "").toLowerCase().includes(s)
      );
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Histórico de Conciliação</h1>
        <p className="text-sm text-muted-foreground">Todas as transações já reconciliadas</p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar por nome, CPF/CNPJ, E2E ID..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="CREDITO">Crédito</SelectItem>
            <SelectItem value="DEBITO">Débito</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border bg-card">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-4 py-3">Tipo</th>
                <th className="px-4 py-3">Contrapartida</th>
                <th className="px-4 py-3">CPF/CNPJ</th>
                <th className="px-4 py-3 text-right">Valor</th>
                <th className="px-4 py-3">Data Transação</th>
                <th className="px-4 py-3">Conciliado em</th>
                <th className="px-4 py-3">Vínculo</th>
              </tr>
            </thead>
            <tbody>
              {isLoading && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">Carregando...</td></tr>
              )}
              {!isLoading && filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center py-8 text-muted-foreground">Nenhum registro encontrado</td></tr>
              )}
              {filtered.map((item: any) => (
                <tr key={item.id} className="border-b border-border/50 hover:bg-muted/20">
                  <td className="px-4 py-2.5">
                    <Badge variant="outline" className={`text-[10px] ${item.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>
                      {item.tipo}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 font-medium">{item.contrapartida || "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground text-xs font-mono">{item.cpf_cnpj || "—"}</td>
                  <td className="px-4 py-2.5 text-right font-semibold">{formatCurrency(Number(item.valor))}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{item.data_hora ? formatDateTime(item.data_hora) : "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{item.reconciliado_em ? formatDateTime(item.reconciliado_em) : "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1 text-xs">
                      <CheckCircle className="h-3 w-3 text-wedo-green" />
                      {item.lancamento_id && <span>Lançamento</span>}
                      {item.grupo_receber_id && <span>Grupo Receber</span>}
                      {item.grupo_pagar_id && <span>Grupo Pagar</span>}
                      {!item.lancamento_id && !item.grupo_receber_id && !item.grupo_pagar_id && <span className="text-muted-foreground">Manual</span>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
            {filtered.length} registro(s)
          </div>
        )}
      </div>
    </div>
  );
}
