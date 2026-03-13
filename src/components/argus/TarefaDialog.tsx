import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import toast from "react-hot-toast";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

export function TarefaDialog({ open, onOpenChange }: Props) {
  const qc = useQueryClient();
  const [titulo, setTitulo] = useState("");
  const [descricao, setDescricao] = useState("");
  const [tipo, setTipo] = useState("geral");
  const [severidade, setSeveridade] = useState("media");

  const create = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fin_tarefas").insert({
        titulo,
        descricao: descricao || null,
        tipo,
        severidade,
        coluna: "a_fazer",
        created_by: "manual",
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fin_tarefas"] });
      toast.success("Tarefa criada");
      setTitulo("");
      setDescricao("");
      onOpenChange(false);
    },
    onError: () => toast.error("Erro ao criar tarefa"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Nova Tarefa</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>Título</Label>
            <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex: Conta a pagar vencida — Fornecedor X" />
          </div>
          <div>
            <Label>Descrição</Label>
            <Textarea value={descricao} onChange={(e) => setDescricao(e.target.value)} rows={3} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={setTipo}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ap">Contas a Pagar</SelectItem>
                  <SelectItem value="ar">Contas a Receber</SelectItem>
                  <SelectItem value="conciliacao">Conciliação</SelectItem>
                  <SelectItem value="compras">Compras</SelectItem>
                  <SelectItem value="orcamentos">Orçamentos</SelectItem>
                  <SelectItem value="compliance">Compliance</SelectItem>
                  <SelectItem value="geral">Geral</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Severidade</Label>
              <Select value={severidade} onValueChange={setSeveridade}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="critica">Crítica</SelectItem>
                  <SelectItem value="alta">Alta</SelectItem>
                  <SelectItem value="media">Média</SelectItem>
                  <SelectItem value="baixa">Baixa</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button onClick={() => create.mutate()} disabled={!titulo.trim() || create.isPending} className="w-full">
            {create.isPending ? "Criando..." : "Criar Tarefa"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
