import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CalendarClock, Plus, Loader2, Play, Pencil, Ban, AlertTriangle } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { executarPagamentoPix } from "@/api/syncService";
import toast from "react-hot-toast";

type Programado = {
  id: string;
  descricao: string;
  nome_fornecedor: string | null;
  valor: number;
  data_vencimento: string;
  chave_pix: string | null;
  status: string | null;
  recorrente: boolean | null;
  frequencia: string | null;
  observacao: string | null;
};

export default function Agendamentos() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("pendente");
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);

  // Form
  const [form, setForm] = useState({ descricao: "", nome_fornecedor: "", valor: "", data_vencimento: "", chave_pix: "", recorrente: false, frequencia: "", observacao: "" });

  const { data: agendamentos, isLoading } = useQuery({
    queryKey: ["agendamentos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("pagamentos_programados")
        .select("id, descricao, nome_fornecedor, valor, data_vencimento, chave_pix, status, recorrente, frequencia, observacao")
        .order("data_vencimento", { ascending: true });
      if (error) throw error;
      return (data || []) as Programado[];
    },
  });

  const filtered = agendamentos?.filter((a) => {
    if (tab === "pendente") return a.status === "pendente" || a.status === "agendado";
    if (tab === "executado") return a.status === "executado";
    if (tab === "cancelado") return a.status === "cancelado";
    return true;
  }) || [];

  const handleSave = async () => {
    if (!form.descricao || !form.valor || !form.data_vencimento) return;
    const { error } = await supabase.from("pagamentos_programados").insert({
      descricao: form.descricao,
      nome_fornecedor: form.nome_fornecedor || null,
      valor: parseFloat(form.valor),
      data_vencimento: form.data_vencimento,
      chave_pix: form.chave_pix || null,
      recorrente: form.recorrente,
      frequencia: form.recorrente ? form.frequencia : null,
      observacao: form.observacao || null,
      status: "pendente",
    });
    if (error) { toast.error(error.message); return; }
    toast.success("Agendamento criado");
    setShowNew(false);
    setForm({ descricao: "", nome_fornecedor: "", valor: "", data_vencimento: "", chave_pix: "", recorrente: false, frequencia: "", observacao: "" });
    queryClient.invalidateQueries({ queryKey: ["agendamentos"] });
  };

  const handleExecutar = async () => {
    if (!selectedId || confirmText !== "CONFIRMAR") return;
    setExecuting(true);
    try {
      await executarPagamentoPix(selectedId);
      toast.success("Pagamento executado");
      setShowConfirm(false);
      queryClient.invalidateQueries({ queryKey: ["agendamentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setExecuting(false);
      setConfirmText("");
    }
  };

  const handleCancelar = async (id: string) => {
    await supabase.from("pagamentos_programados").update({ status: "cancelado" }).eq("id", id);
    toast.success("Agendamento cancelado");
    queryClient.invalidateQueries({ queryKey: ["agendamentos"] });
  };

  const statusBadge = (s: string | null) => {
    if (s === "executado") return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Executado</Badge>;
    if (s === "cancelado") return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Cancelado</Badge>;
    if (s === "erro") return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Erro</Badge>;
    return <Badge variant="outline" className="bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 text-[10px]">Pendente</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Agendamentos</h1>
          <p className="text-sm text-muted-foreground">Pagamentos programados via PIX</p>
        </div>
        <Button size="sm" onClick={() => setShowNew(true)}>
          <Plus className="h-3.5 w-3.5 mr-1.5" /> Novo Agendamento
        </Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pendente">Pendentes</TabsTrigger>
          <TabsTrigger value="executado">Executados</TabsTrigger>
          <TabsTrigger value="cancelado">Cancelados</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
              <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Chave PIX</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan={7} className="p-0">
                <EmptyState icon={CalendarClock} title="Nenhum agendamento" description="Crie agendamentos para programar pagamentos." />
              </td></tr>
            ) : (
              filtered.map((a) => (
                <tr key={a.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 text-foreground">{a.descricao}</td>
                  <td className="p-3 text-foreground">{a.nome_fornecedor || "—"}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(a.valor)}</td>
                  <td className="p-3 text-foreground">{formatDate(a.data_vencimento)}</td>
                  <td className="p-3 text-foreground text-xs font-mono truncate max-w-[120px]">{a.chave_pix || "—"}</td>
                  <td className="p-3 text-center">{statusBadge(a.status)}</td>
                  <td className="p-3 text-center">
                    {(a.status === "pendente" || a.status === "agendado") && (
                      <div className="flex gap-1 justify-center">
                        <Button size="sm" variant="ghost" onClick={() => { setSelectedId(a.id); setShowConfirm(true); setConfirmText(""); }}>
                          <Play className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleCancelar(a.id)}>
                          <Ban className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* New Dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader><DialogTitle>Novo Agendamento</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Descrição *</Label><Input value={form.descricao} onChange={(e) => setForm({ ...form, descricao: e.target.value })} /></div>
            <div className="space-y-2"><Label>Fornecedor</Label><Input value={form.nome_fornecedor} onChange={(e) => setForm({ ...form, nome_fornecedor: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Valor *</Label><Input type="number" step="0.01" value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} /></div>
              <div className="space-y-2"><Label>Vencimento *</Label><Input type="date" value={form.data_vencimento} onChange={(e) => setForm({ ...form, data_vencimento: e.target.value })} /></div>
            </div>
            <div className="space-y-2"><Label>Chave PIX destino</Label><Input value={form.chave_pix} onChange={(e) => setForm({ ...form, chave_pix: e.target.value })} /></div>
            <div className="flex items-center gap-3">
              <Switch checked={form.recorrente} onCheckedChange={(v) => setForm({ ...form, recorrente: v })} />
              <Label className="text-sm">Recorrente</Label>
            </div>
            {form.recorrente && (
              <div className="space-y-2"><Label>Frequência</Label><Input value={form.frequencia} onChange={(e) => setForm({ ...form, frequencia: e.target.value })} placeholder="mensal, semanal, quinzenal" /></div>
            )}
            <div className="space-y-2"><Label>Observação</Label><Textarea value={form.observacao} onChange={(e) => setForm({ ...form, observacao: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={!form.descricao || !form.valor || !form.data_vencimento}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Execute */}
      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-wedo-orange" /> Confirmar Pagamento PIX</DialogTitle>
            <DialogDescription>Esta ação executará o pagamento via PIX pelo Banco Inter.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label className="text-xs">Digite <strong>CONFIRMAR</strong></Label>
              <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="CONFIRMAR" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowConfirm(false)}>Cancelar</Button>
            <Button variant="destructive" onClick={handleExecutar} disabled={confirmText !== "CONFIRMAR" || executing}>
              {executing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Executar Pagamento
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
