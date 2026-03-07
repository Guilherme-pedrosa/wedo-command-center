import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Layers, LayoutGrid, List, RefreshCw, Eye, QrCode, Ban, CheckCircle, XCircle, AlertTriangle, Loader2, Copy } from "lucide-react";
import { formatCurrency, formatDate, formatDateTime, formatTimeAgo } from "@/lib/format";
import { baixarGrupo, gerarCobrancaPix, verificarCobrancaPix } from "@/api/syncService";
import toast from "react-hot-toast";

type Grupo = {
  id: string;
  nome: string;
  nome_cliente: string | null;
  valor_total: number;
  status: string;
  data_vencimento: string | null;
  data_pagamento: string | null;
  valor_recebido: number | null;
  qtd_itens: number | null;
  baixado_gc: boolean | null;
  inter_txid: string | null;
  inter_qrcode: string | null;
  inter_copia_cola: string | null;
  observacao: string | null;
  created_at: string | null;
};

type GrupoItem = {
  id: string;
  gc_codigo: string | null;
  os_codigo: string | null;
  descricao: string | null;
  valor: number;
  baixado_gc: boolean | null;
  baixado_gc_em: string | null;
  erro_baixa: string | null;
  nome_cliente: string | null;
};

export default function Grupos() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<"cards" | "table">("cards");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedGrupo, setSelectedGrupo] = useState<Grupo | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [confirmDate, setConfirmDate] = useState(new Date().toISOString().split("T")[0]);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const { data: grupos, isLoading } = useQuery({
    queryKey: ["grupos-financeiros"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grupos_financeiros")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as Grupo[];
    },
  });

  const { data: itens } = useQuery({
    queryKey: ["grupo-itens", selectedGrupo?.id],
    enabled: !!selectedGrupo,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("grupo_itens")
        .select("*")
        .eq("grupo_id", selectedGrupo!.id);
      if (error) throw error;
      return (data || []) as GrupoItem[];
    },
  });

  const { data: logs } = useQuery({
    queryKey: ["grupo-logs", selectedGrupo?.id],
    enabled: !!selectedGrupo,
    queryFn: async () => {
      const { data } = await supabase
        .from("sync_log")
        .select("*")
        .eq("referencia_id", selectedGrupo!.id)
        .order("created_at", { ascending: false })
        .limit(20);
      return data || [];
    },
  });

  const filtered = grupos?.filter((g) => statusFilter === "todos" || g.status === statusFilter) || [];

  const statusBadge = (status: string) => {
    const map: Record<string, string> = {
      aberto: "bg-muted text-muted-foreground",
      aguardando_pagamento: "bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 animate-pulse-dot",
      pago: "bg-wedo-green/10 text-wedo-green border-wedo-green/30",
      pago_parcial: "bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30",
      cancelado: "bg-wedo-red/10 text-wedo-red border-wedo-red/30",
    };
    return <Badge variant="outline" className={`${map[status] || ""} text-[10px]`}>{status.replace("_", " ")}</Badge>;
  };

  const handleBaixar = async () => {
    if (!selectedGrupo || confirmText !== "CONFIRMAR") return;
    setExecuting(true);
    try {
      const result = await baixarGrupo(selectedGrupo.id, confirmDate);
      if (result.falha === 0) {
        toast.success(`Grupo quitado: ${result.sucesso} itens baixados`);
        setShowConfirm(false);
      } else {
        toast.error(`Parcial: ${result.sucesso} OK, ${result.falha} falha(s)`);
      }
      queryClient.invalidateQueries({ queryKey: ["grupos-financeiros"] });
      queryClient.invalidateQueries({ queryKey: ["grupo-itens", selectedGrupo.id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setExecuting(false);
      setConfirmText("");
    }
  };

  const handleGerarPix = async (grupo: Grupo) => {
    try {
      const result = await gerarCobrancaPix(grupo.id);
      toast.success("Cobrança PIX gerada");
      queryClient.invalidateQueries({ queryKey: ["grupos-financeiros"] });
      setSelectedGrupo({ ...grupo, inter_txid: result.txid, inter_qrcode: result.qrcode, inter_copia_cola: result.copiaCola, status: "aguardando_pagamento" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao gerar PIX");
    }
  };

  const handleVerificarPix = async () => {
    if (!selectedGrupo?.inter_txid) return;
    try {
      const result = await verificarCobrancaPix(selectedGrupo.inter_txid);
      if (result.pago) {
        toast.success(`Pagamento confirmado! ${result.pagadorNome || ""}`);
      } else {
        toast(`Status: ${result.status}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    }
  };

  const handleCancelar = async (grupo: Grupo) => {
    await supabase.from("grupos_financeiros").update({ status: "cancelado" }).eq("id", grupo.id);
    // Release recebimentos
    await supabase.from("gc_recebimentos").update({ grupo_id: null }).eq("grupo_id" as any, grupo.id);
    toast.success("Grupo cancelado");
    queryClient.invalidateQueries({ queryKey: ["grupos-financeiros"] });
    setSelectedGrupo(null);
  };

  const baixadosCount = itens?.filter((i) => i.baixado_gc).length || 0;
  const totalItens = itens?.length || 0;

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
              <TabsTrigger value="cards" className="h-7 px-2"><LayoutGrid className="h-3.5 w-3.5" /></TabsTrigger>
              <TabsTrigger value="table" className="h-7 px-2"><List className="h-3.5 w-3.5" /></TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Status filter */}
      <div className="flex gap-2 flex-wrap">
        {["todos", "aberto", "aguardando_pagamento", "pago", "pago_parcial", "cancelado"].map((s) => (
          <Button key={s} size="sm" variant={statusFilter === s ? "default" : "outline"} onClick={() => setStatusFilter(s)} className="text-xs">
            {s === "todos" ? "Todos" : s.replace("_", " ")}
          </Button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <EmptyState icon={Layers} title="Nenhum grupo" description="Selecione recebimentos na página de Recebimentos e crie grupos para cobrança." action={{ label: "Ir para Recebimentos", onClick: () => window.location.href = "/recebimentos" }} />
      ) : view === "cards" ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filtered.map((g) => (
            <div key={g.id} className="rounded-lg border border-border bg-card p-4 space-y-3">
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-foreground text-sm">{g.nome}</h3>
                  <p className="text-xs text-muted-foreground">{g.nome_cliente}</p>
                </div>
                {statusBadge(g.status)}
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Valor</span>
                <span className="font-semibold text-foreground">{formatCurrency(g.valor_total)}</span>
              </div>
              {g.data_vencimento && (
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Vencimento</span>
                  <span className="text-foreground">{formatDate(g.data_vencimento)}</span>
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => setSelectedGrupo(g)}>
                  <Eye className="h-3 w-3 mr-1" /> Detalhes
                </Button>
                {(g.status === "aberto" || g.status === "aguardando_pagamento") && (
                  <Button size="sm" variant="outline" className="text-xs" onClick={() => handleGerarPix(g)}>
                    <QrCode className="h-3 w-3 mr-1" /> PIX
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Nome</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cliente</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g) => (
                <tr key={g.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 text-foreground font-medium">{g.nome}</td>
                  <td className="p-3 text-foreground">{g.nome_cliente || "—"}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(g.valor_total)}</td>
                  <td className="p-3 text-foreground">{g.data_vencimento ? formatDate(g.data_vencimento) : "—"}</td>
                  <td className="p-3 text-center">{statusBadge(g.status)}</td>
                  <td className="p-3 text-center">
                    <Button size="sm" variant="ghost" onClick={() => setSelectedGrupo(g)}><Eye className="h-3.5 w-3.5" /></Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail Sheet */}
      <Sheet open={!!selectedGrupo} onOpenChange={(open) => !open && setSelectedGrupo(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>{selectedGrupo?.nome}</SheetTitle>
            <SheetDescription>{selectedGrupo?.nome_cliente} · {selectedGrupo ? formatCurrency(selectedGrupo.valor_total) : ""}</SheetDescription>
          </SheetHeader>

          {selectedGrupo && (
            <div className="mt-6 space-y-6">
              {/* Status */}
              <div className="flex items-center gap-2">
                {statusBadge(selectedGrupo.status)}
                {selectedGrupo.data_vencimento && <span className="text-xs text-muted-foreground">Vence: {formatDate(selectedGrupo.data_vencimento)}</span>}
              </div>

              {/* Progress */}
              {totalItens > 0 && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Baixados no GC</span>
                    <span>{baixadosCount}/{totalItens}</span>
                  </div>
                  <Progress value={(baixadosCount / totalItens) * 100} className="h-2" />
                </div>
              )}

              {/* Itens */}
              <div>
                <h4 className="text-sm font-semibold text-foreground mb-2">Itens</h4>
                <div className="space-y-2">
                  {itens?.map((item) => (
                    <div key={item.id} className="flex items-center justify-between p-2 rounded-md bg-muted/50 text-xs">
                      <div className="flex items-center gap-2">
                        {item.baixado_gc ? <CheckCircle className="h-3.5 w-3.5 text-wedo-green" /> : item.erro_baixa ? <XCircle className="h-3.5 w-3.5 text-wedo-red" /> : <span className="h-3.5 w-3.5 rounded-full border border-muted-foreground" />}
                        <div>
                          <span className="text-foreground">{item.os_codigo || item.gc_codigo} — {item.nome_cliente}</span>
                          {item.erro_baixa && <p className="text-wedo-red text-[10px]">{item.erro_baixa}</p>}
                        </div>
                      </div>
                      <span className="font-semibold text-foreground">{formatCurrency(item.valor)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* PIX */}
              {selectedGrupo.inter_txid && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-2">Cobrança PIX</h4>
                  <div className="rounded-md bg-muted/50 p-3 space-y-2">
                    <p className="text-xs text-muted-foreground">TXID: {selectedGrupo.inter_txid}</p>
                    {selectedGrupo.inter_copia_cola && (
                      <div className="flex items-center gap-2">
                        <Input readOnly value={selectedGrupo.inter_copia_cola} className="text-xs" />
                        <Button size="sm" variant="outline" onClick={() => { navigator.clipboard.writeText(selectedGrupo.inter_copia_cola || ""); toast.success("Copiado!"); }}>
                          <Copy className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                    <Button size="sm" variant="outline" onClick={handleVerificarPix}>
                      <RefreshCw className="h-3 w-3 mr-1" /> Verificar Pagamento
                    </Button>
                  </div>
                </div>
              )}

              {/* Activity */}
              {logs && logs.length > 0 && (
                <div>
                  <h4 className="text-sm font-semibold text-foreground mb-2">Atividade</h4>
                  <div className="space-y-1">
                    {logs.map((log) => (
                      <div key={log.id} className="flex items-center gap-2 text-xs p-1">
                        {log.status === "success" ? <CheckCircle className="h-3 w-3 text-wedo-green" /> : <XCircle className="h-3 w-3 text-wedo-red" />}
                        <span className="text-muted-foreground">{log.tipo}</span>
                        <span className="text-muted-foreground ml-auto">{log.created_at ? formatTimeAgo(log.created_at) : ""}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-4 border-t border-border">
                {selectedGrupo.status !== "pago" && selectedGrupo.status !== "cancelado" && (
                  <>
                    <Button size="sm" onClick={() => { setShowConfirm(true); setConfirmText(""); }}>
                      Quitar Grupo
                    </Button>
                    {(selectedGrupo.status === "aberto" || selectedGrupo.status === "aguardando_pagamento") && (
                      <Button size="sm" variant="outline" onClick={() => handleGerarPix(selectedGrupo)}>
                        <QrCode className="h-3 w-3 mr-1" /> Gerar PIX
                      </Button>
                    )}
                  </>
                )}
                {selectedGrupo.status === "aberto" && (
                  <Button size="sm" variant="destructive" onClick={() => handleCancelar(selectedGrupo)}>
                    <Ban className="h-3 w-3 mr-1" /> Cancelar
                  </Button>
                )}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Confirm Dialog */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-wedo-orange" />
              Confirmar Baixa no GC — Operação Irreversível
            </DialogTitle>
            <DialogDescription>
              Os recebimentos abaixo serão quitados no GestãoClick. Esta ação NÃO pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {itens?.filter((i) => !i.baixado_gc).map((item) => (
              <div key={item.id} className="flex justify-between text-xs p-2 bg-muted/50 rounded">
                <span className="text-foreground">{item.os_codigo || item.gc_codigo}</span>
                <span className="font-semibold text-foreground">{formatCurrency(item.valor)}</span>
              </div>
            ))}
            <div className="space-y-2">
              <Label className="text-xs">Data de liquidação</Label>
              <Input type="date" value={confirmDate} onChange={(e) => setConfirmDate(e.target.value)} />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Digite <strong>CONFIRMAR</strong> para prosseguir</Label>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="CONFIRMAR" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirm(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleBaixar} disabled={confirmText !== "CONFIRMAR" || executing}>
              {executing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Quitar Grupo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
