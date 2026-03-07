import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { baixarGrupoPagarNoGC } from "@/api/financeiro";
import { Layers, Zap, Loader2, CheckCircle, Eye } from "lucide-react";
import toast from "react-hot-toast";

export default function GruposPagarPage() {
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedGrupo, setSelectedGrupo] = useState<any>(null);
  const [showBaixa, setShowBaixa] = useState(false);
  const [baixaGrupoId, setBaixaGrupoId] = useState("");

  const { data: grupos, isLoading } = useQuery({
    queryKey: ["fin-grupos-pagar", statusFilter],
    queryFn: async () => {
      let q = supabase.from("fin_grupos_pagar").select("*").order("created_at", { ascending: false });
      if (statusFilter !== "todos") q = q.eq("status", statusFilter as any);
      const { data } = await q;
      return data || [];
    },
  });

  const { data: grupoItens } = useQuery({
    queryKey: ["fin-grupo-pagar-itens", selectedGrupo?.id],
    enabled: !!selectedGrupo,
    queryFn: async () => {
      const { data } = await supabase.from("fin_grupo_pagar_itens").select("*, fin_pagamentos(gc_id, gc_codigo, descricao, valor, pago_sistema, gc_baixado)").eq("grupo_id", selectedGrupo.id);
      return data || [];
    },
  });

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { aberto: "bg-muted/50 text-muted-foreground", aguardando_pagamento: "bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 animate-pulse", pago: "bg-wedo-green/10 text-wedo-green border-wedo-green/30", pago_parcial: "bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30", cancelado: "bg-muted/50 text-muted-foreground" };
    return <Badge variant="outline" className={`${map[s] || ""} text-[10px]`}>{s.replace("_", " ")}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Grupos a Pagar</h1><p className="text-sm text-muted-foreground">Grupos de pagamentos</p></div>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="aberto">Aberto</SelectItem><SelectItem value="aguardando_pagamento">Aguardando</SelectItem><SelectItem value="pago">Pago</SelectItem><SelectItem value="pago_parcial">Parcial</SelectItem></SelectContent></Select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Nome</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
            <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
          </tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            : !grupos?.length ? <tr><td colSpan={7}><EmptyState icon={Layers} title="Nenhum grupo" description="Crie grupos na tela de pagamentos." /></td></tr>
            : grupos.map((g: any) => (
              <tr key={g.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-medium">{g.nome}</td>
                <td className="p-3">{g.nome_fornecedor || "—"}</td>
                <td className="p-3 text-right font-semibold">{formatCurrency(Number(g.valor_total))}</td>
                <td className="p-3">{g.data_vencimento ? formatDate(g.data_vencimento) : "—"}</td>
                <td className="p-3 text-center">{statusBadge(g.status)}</td>
                <td className="p-3 text-center">{g.gc_baixado ? <span className="text-wedo-green text-[10px]">✅</span> : g.inter_pago_em ? <Button size="sm" variant="outline" className="text-wedo-orange border-wedo-orange/30 text-[10px] h-7" onClick={() => { setBaixaGrupoId(g.id); setShowBaixa(true); }}><Zap className="h-3 w-3 mr-1" />Baixar</Button> : "—"}</td>
                <td className="p-3 text-center"><Button variant="ghost" size="sm" className="h-7" onClick={() => setSelectedGrupo(g)}><Eye className="h-3 w-3" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sheet open={!!selectedGrupo} onOpenChange={o => !o && setSelectedGrupo(null)}>
        <SheetContent className="w-[500px] overflow-y-auto">
          {selectedGrupo && (
            <><SheetHeader><SheetTitle>{selectedGrupo.nome}</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-6">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-muted-foreground">Fornecedor</span><p className="font-medium">{selectedGrupo.nome_fornecedor || "—"}</p></div>
                  <div><span className="text-muted-foreground">Valor</span><p className="font-semibold">{formatCurrency(Number(selectedGrupo.valor_total))}</p></div>
                  <div><span className="text-muted-foreground">Status</span><p>{statusBadge(selectedGrupo.status)}</p></div>
                </div>
                {selectedGrupo.inter_pago_em && <div className="flex items-center gap-2 text-wedo-green text-sm"><CheckCircle className="h-4 w-4" />Pago via Inter em {formatDateTime(selectedGrupo.inter_pago_em)}</div>}
                {selectedGrupo.inter_pago_em && !selectedGrupo.gc_baixado && (
                  <div className="rounded-lg bg-wedo-orange/10 border border-wedo-orange/30 p-4"><Button variant="destructive" onClick={() => { setBaixaGrupoId(selectedGrupo.id); setShowBaixa(true); }}>Enviar Baixa para GC</Button></div>
                )}
                <div><h4 className="text-sm font-semibold mb-2">Itens</h4>
                  <div className="rounded-md border border-border overflow-hidden"><table className="w-full text-xs"><thead className="bg-muted/50"><tr><th className="p-2 text-left">Cód</th><th className="p-2 text-left">Desc</th><th className="p-2 text-right">Valor</th><th className="p-2 text-center">Baixa</th></tr></thead>
                  <tbody>{grupoItens?.map((i: any) => { const p = i.fin_pagamentos; return <tr key={i.id} className="border-t border-border"><td className="p-2 font-mono">{p?.gc_codigo || "—"}</td><td className="p-2 truncate max-w-[150px]">{p?.descricao}</td><td className="p-2 text-right">{formatCurrency(Number(i.valor || p?.valor))}</td><td className="p-2 text-center">{i.gc_baixado ? "✅" : "⏳"}</td></tr>; })}</tbody></table></div>
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmarBaixaModal open={showBaixa} onOpenChange={(o) => { if (!o) { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-grupos-pagar"] }); } }}
        titulo="Baixa do Grupo no GC" tipoLancamento="pagamento"
        itens={grupoItens?.map((i: any) => ({ id: i.id, descricao: i.fin_pagamentos?.descricao || "", valor: Number(i.valor || i.fin_pagamentos?.valor), gc_id: i.fin_pagamentos?.gc_id || "", gc_payload_raw: i.fin_pagamentos?.gc_payload_raw, gc_baixado: i.gc_baixado })) || []}
        onConfirmar={async (dataLiq) => { await baixarGrupoPagarNoGC(baixaGrupoId || selectedGrupo?.id, dataLiq); }} />
    </div>
  );
}
