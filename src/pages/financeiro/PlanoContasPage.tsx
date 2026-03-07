import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { BookOpen, Plus, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

export default function PlanoContasPage() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ nome: "", codigo: "", tipo: "receita" as "receita" | "despesa" });

  const { data: plano, isLoading } = useQuery({
    queryKey: ["fin-plano-contas"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_plano_contas").select("*").order("codigo");
      return data || [];
    },
  });

  const handleCreate = async () => {
    if (!form.nome) return;
    setCreating(true);
    try {
      await supabase.from("fin_plano_contas").insert({ nome: form.nome, codigo: form.codigo || null, tipo: form.tipo });
      toast.success("Conta criada");
      setShowCreate(false); setForm({ nome: "", codigo: "", tipo: "receita" });
      queryClient.invalidateQueries({ queryKey: ["fin-plano-contas"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setCreating(false); }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Plano de Contas</h1><p className="text-sm text-muted-foreground">Categorias de receitas e despesas</p></div>
        <Button size="sm" onClick={() => setShowCreate(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />Nova Conta</Button>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Código</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Nome</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Tipo</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ativo</th>
          </tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={4} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            : !plano?.length ? <tr><td colSpan={4}><EmptyState icon={BookOpen} title="Sem contas" description="Crie categorias para organizar lançamentos." /></td></tr>
            : plano.map((c: any) => (
              <tr key={c.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-mono text-xs">{c.codigo || "—"}</td>
                <td className="p-3 font-medium">{c.nome}</td>
                <td className="p-3 text-center"><Badge variant="outline" className={`text-[10px] ${c.tipo === "receita" ? "text-wedo-green" : "text-wedo-red"}`}>{c.tipo}</Badge></td>
                <td className="p-3 text-center">{c.ativo ? "✅" : "❌"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent><DialogHeader><DialogTitle>Nova Conta</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Nome *</Label><Input value={form.nome} onChange={e => setForm({ ...form, nome: e.target.value })} /></div>
            <div className="space-y-2"><Label>Código</Label><Input value={form.codigo} onChange={e => setForm({ ...form, codigo: e.target.value })} placeholder="Ex: 3.1.01" /></div>
            <div className="space-y-2"><Label>Tipo</Label><Select value={form.tipo} onValueChange={(v: any) => setForm({ ...form, tipo: v })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="receita">Receita</SelectItem><SelectItem value="despesa">Despesa</SelectItem></SelectContent></Select></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setShowCreate(false)}>Cancelar</Button><Button onClick={handleCreate} disabled={creating || !form.nome}>{creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
