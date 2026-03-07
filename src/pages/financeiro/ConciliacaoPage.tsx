import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { ArrowLeftRight, CheckCircle, Loader2, Wand2 } from "lucide-react";
import toast from "react-hot-toast";

export default function ConciliacaoPage() {
  const queryClient = useQueryClient();
  const [selectedExtrato, setSelectedExtrato] = useState<any>(null);
  const [selectedLanc, setSelectedLanc] = useState<any>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [linking, setLinking] = useState(false);

  const { data: extratoNR } = useQuery({
    queryKey: ["conc-extrato"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_extrato_inter").select("*").eq("reconciliado", false).order("data_hora", { ascending: false }).limit(50);
      return data || [];
    },
  });

  const { data: recebimentosNL } = useQuery({
    queryKey: ["conc-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_recebimentos").select("id, descricao, valor, nome_cliente, data_vencimento, status").eq("liquidado", false).order("data_vencimento").limit(50);
      return data || [];
    },
  });

  const { data: pagamentosNL } = useQuery({
    queryKey: ["conc-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos").select("id, descricao, valor, nome_fornecedor, data_vencimento, status").eq("liquidado", false).order("data_vencimento").limit(50);
      return data || [];
    },
  });

  const handleSelectExtrato = (e: any) => {
    setSelectedExtrato(e);
    if (selectedLanc) setShowConfirm(true);
  };

  const handleSelectLanc = (l: any, tipo: "receber" | "pagar") => {
    setSelectedLanc({ ...l, _tipo: tipo });
    if (selectedExtrato) setShowConfirm(true);
  };

  const handleVincular = async () => {
    if (!selectedExtrato || !selectedLanc) return;
    setLinking(true);
    try {
      await supabase.from("fin_extrato_inter").update({ reconciliado: true, lancamento_id: selectedLanc.id, reconciliado_em: new Date().toISOString() }).eq("id", selectedExtrato.id);
      const table = selectedLanc._tipo === "receber" ? "fin_recebimentos" : "fin_pagamentos";
      await supabase.from(table).update({ pago_sistema: true, pago_sistema_em: new Date().toISOString() }).eq("id", selectedLanc.id);
      toast.success("Vinculado com sucesso");
      setSelectedExtrato(null); setSelectedLanc(null); setShowConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["conc-extrato"] });
      queryClient.invalidateQueries({ queryKey: ["conc-recebimentos"] });
      queryClient.invalidateQueries({ queryKey: ["conc-pagamentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setLinking(false); }
  };

  const diff = selectedExtrato && selectedLanc ? Math.abs(Number(selectedExtrato.valor) - Number(selectedLanc.valor)) : 0;

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold text-foreground">Conciliação</h1><p className="text-sm text-muted-foreground">Vincule transações do extrato a lançamentos do sistema</p></div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Left: Extrato */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">🏦 Extrato Inter não reconciliado ({extratoNR?.length || 0})</h3>
          <div className="space-y-2 max-h-[60vh] overflow-y-auto">
            {extratoNR?.map((e: any) => (
              <div key={e.id} onClick={() => handleSelectExtrato(e)} className={`p-3 rounded-md border cursor-pointer transition-colors ${selectedExtrato?.id === e.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"}`}>
                <div className="flex justify-between items-center">
                  <Badge variant="outline" className={`text-[10px] ${e.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>{e.tipo}</Badge>
                  <span className="font-semibold text-sm">{formatCurrency(Number(e.valor))}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">{e.contrapartida}</p>
                <p className="text-[10px] text-muted-foreground">{e.data_hora ? formatDateTime(e.data_hora) : ""}</p>
              </div>
            ))}
            {!extratoNR?.length && <p className="text-sm text-muted-foreground text-center py-4">Tudo reconciliado ✅</p>}
          </div>
        </div>

        {/* Right: Lançamentos */}
        <div className="rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">📋 Lançamentos não liquidados</h3>
          <div className="space-y-1 max-h-[30vh] overflow-y-auto mb-4">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase px-1">A Receber ({recebimentosNL?.length || 0})</p>
            {recebimentosNL?.map((r: any) => (
              <div key={r.id} onClick={() => handleSelectLanc(r, "receber")} className={`p-2 rounded-md border cursor-pointer transition-colors text-xs ${selectedLanc?.id === r.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"}`}>
                <div className="flex justify-between"><span className="truncate">{r.descricao}</span><span className="font-semibold">{formatCurrency(Number(r.valor))}</span></div>
                <p className="text-[10px] text-muted-foreground">{r.nome_cliente}</p>
              </div>
            ))}
          </div>
          <div className="space-y-1 max-h-[30vh] overflow-y-auto">
            <p className="text-[10px] font-semibold text-muted-foreground uppercase px-1">A Pagar ({pagamentosNL?.length || 0})</p>
            {pagamentosNL?.map((p: any) => (
              <div key={p.id} onClick={() => handleSelectLanc(p, "pagar")} className={`p-2 rounded-md border cursor-pointer transition-colors text-xs ${selectedLanc?.id === p.id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"}`}>
                <div className="flex justify-between"><span className="truncate">{p.descricao}</span><span className="font-semibold">{formatCurrency(Number(p.valor))}</span></div>
                <p className="text-[10px] text-muted-foreground">{p.nome_fornecedor}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Confirm dialog */}
      <Dialog open={showConfirm} onOpenChange={o => { if (!o) { setShowConfirm(false); } }}>
        <DialogContent><DialogHeader><DialogTitle>Vincular transação</DialogTitle></DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-md bg-muted/50 p-3"><strong>Extrato:</strong> {selectedExtrato?.tipo} · {formatCurrency(Number(selectedExtrato?.valor))} · {selectedExtrato?.contrapartida}</div>
            <div className="flex justify-center"><ArrowLeftRight className="h-5 w-5 text-muted-foreground" /></div>
            <div className="rounded-md bg-muted/50 p-3"><strong>Lançamento:</strong> {selectedLanc?.descricao} · {formatCurrency(Number(selectedLanc?.valor))}</div>
            {diff <= 0.01 ? <div className="text-wedo-green text-xs flex items-center gap-1"><CheckCircle className="h-3 w-3" />Valores compatíveis</div> : <div className="text-wedo-orange text-xs">⚠️ Diferença de {formatCurrency(diff)}</div>}
            <p className="text-xs text-muted-foreground">Nota: isto NÃO faz baixa no GC. Apenas marca como pago no sistema.</p>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => { setShowConfirm(false); setSelectedExtrato(null); setSelectedLanc(null); }}>Cancelar</Button><Button onClick={handleVincular} disabled={linking}>{linking && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Vincular</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
