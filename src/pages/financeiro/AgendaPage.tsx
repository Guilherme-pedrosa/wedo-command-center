import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState } from "@/components/EmptyState";
import { formatCurrency, formatDate } from "@/lib/format";
import { enviarPagamentoPix } from "@/api/financeiro";
import { CalendarClock, Plus, Loader2, Zap, AlertTriangle } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

export default function AgendaPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState("pendente");
  const [showCreate, setShowCreate] = useState(false);
  const [showConfirmPix, setShowConfirmPix] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const [executing, setExecuting] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ descricao: "", nome_fornecedor: "", valor: "", chave_pix_destino: "", tipo_chave: "cnpj", observacao: "" });
  const [formDate, setFormDate] = useState<Date | undefined>(undefined);

  const { data: agenda, isLoading } = useQuery({
    queryKey: ["fin-agenda", tab],
    queryFn: async () => {
      let q = supabase.from("fin_agenda_pagamentos").select("*").order("data_vencimento", { ascending: true });
      if (tab !== "todos") q = q.eq("status", tab);
      const { data } = await q;
      return data || [];
    },
  });

  const handleCreate = async () => {
    if (!form.descricao || !form.valor || !formDate) return;
    setCreating(true);
    try {
      await supabase.from("fin_agenda_pagamentos").insert({
        descricao: form.descricao, nome_fornecedor: form.nome_fornecedor || null,
        valor: parseFloat(form.valor), data_vencimento: format(formDate, "yyyy-MM-dd"),
        chave_pix_destino: form.chave_pix_destino || null, tipo_chave: form.tipo_chave,
        observacao: form.observacao || null,
      });
      toast.success("Pagamento programado criado");
      setShowCreate(false); setForm({ descricao: "", nome_fornecedor: "", valor: "", chave_pix_destino: "", tipo_chave: "cnpj", observacao: "" }); setFormDate(undefined);
      queryClient.invalidateQueries({ queryKey: ["fin-agenda"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setCreating(false); }
  };

  const handleExecutarPix = async () => {
    if (!showConfirmPix || confirmText !== "CONFIRMAR") return;
    setExecuting(true);
    try {
      const r = await enviarPagamentoPix(showConfirmPix);
      toast.success(`PIX enviado: ${r.endToEndId}`);
      setShowConfirmPix(null); setConfirmText("");
      queryClient.invalidateQueries({ queryKey: ["fin-agenda"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setExecuting(false); }
  };

  const statusBadge = (s: string) => {
    const map: Record<string, string> = { pendente: "bg-wedo-yellow/10 text-wedo-yellow", executado: "bg-wedo-green/10 text-wedo-green", cancelado: "bg-muted/50 text-muted-foreground", erro: "bg-wedo-red/10 text-wedo-red" };
    return <Badge variant="outline" className={`${map[s] || ""} text-[10px]`}>{s}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Agenda de Pagamentos</h1><p className="text-sm text-muted-foreground">Pagamentos programados via PIX Inter</p></div>
        <Button size="sm" onClick={() => setShowCreate(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />Novo Pagamento</Button>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList><TabsTrigger value="pendente">Pendentes</TabsTrigger><TabsTrigger value="executado">Executados</TabsTrigger><TabsTrigger value="cancelado">Cancelados</TabsTrigger><TabsTrigger value="erro">Com Erro</TabsTrigger></TabsList>
      </Tabs>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
            <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Chave PIX</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
          </tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            : !agenda?.length ? <tr><td colSpan={7}><EmptyState icon={CalendarClock} title="Nenhum agendamento" description="Crie um novo pagamento programado." /></td></tr>
            : agenda.map((a: any) => (
              <tr key={a.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3">{a.descricao}</td>
                <td className="p-3">{a.nome_fornecedor || "—"}</td>
                <td className="p-3 text-right font-semibold">{formatCurrency(Number(a.valor))}</td>
                <td className="p-3">{formatDate(a.data_vencimento)}</td>
                <td className="p-3 text-xs font-mono">{a.chave_pix_destino || "—"}</td>
                <td className="p-3 text-center">{statusBadge(a.status)}</td>
                <td className="p-3 text-center">
                  {a.status === "pendente" && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setShowConfirmPix(a.id)}><Zap className="h-3 w-3 mr-1" />Executar PIX</Button>}
                  {a.ultimo_erro && <span className="text-wedo-red text-[10px] block mt-1">{a.ultimo_erro}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent><DialogHeader><DialogTitle>Novo Pagamento Programado</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Descrição *</Label><Input value={form.descricao} onChange={e => setForm({ ...form, descricao: e.target.value })} /></div>
            <div className="space-y-2"><Label>Fornecedor</Label><Input value={form.nome_fornecedor} onChange={e => setForm({ ...form, nome_fornecedor: e.target.value })} /></div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Valor *</Label><Input type="number" step="0.01" value={form.valor} onChange={e => setForm({ ...form, valor: e.target.value })} /></div>
              <div className="space-y-2"><Label>Vencimento *</Label>
                <Popover><PopoverTrigger asChild><Button variant="outline" className="w-full justify-start"><CalendarIcon className="mr-2 h-4 w-4" />{formDate ? format(formDate, "dd/MM/yyyy") : "Selecionar"}</Button></PopoverTrigger>
                <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={formDate} onSelect={setFormDate} locale={ptBR} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2"><Label>Chave PIX *</Label><Input value={form.chave_pix_destino} onChange={e => setForm({ ...form, chave_pix_destino: e.target.value })} /></div>
              <div className="space-y-2"><Label>Tipo chave</Label><Select value={form.tipo_chave} onValueChange={v => setForm({ ...form, tipo_chave: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cpf">CPF</SelectItem><SelectItem value="cnpj">CNPJ</SelectItem><SelectItem value="email">Email</SelectItem><SelectItem value="telefone">Telefone</SelectItem><SelectItem value="aleatoria">Aleatória</SelectItem></SelectContent></Select></div>
            </div>
            <div className="space-y-2"><Label>Observação</Label><Textarea value={form.observacao} onChange={e => setForm({ ...form, observacao: e.target.value })} /></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setShowCreate(false)}>Cancelar</Button><Button onClick={handleCreate} disabled={creating || !form.descricao || !form.valor || !formDate}>{creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm PIX */}
      <Dialog open={!!showConfirmPix} onOpenChange={o => { if (!o) { setShowConfirmPix(null); setConfirmText(""); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive" />Confirmar envio de PIX</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="bg-destructive/10 border border-destructive/30 rounded-md p-3 text-sm text-destructive">Esta operação enviará dinheiro real via PIX e não pode ser desfeita.</div>
            <div className="space-y-2"><Label>Digite CONFIRMAR</Label><Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="CONFIRMAR" /></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => { setShowConfirmPix(null); setConfirmText(""); }}>Cancelar</Button><Button variant="destructive" onClick={handleExecutarPix} disabled={confirmText !== "CONFIRMAR" || executing}>{executing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Zap className="h-3.5 w-3.5 mr-1.5" />}Enviar PIX</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
