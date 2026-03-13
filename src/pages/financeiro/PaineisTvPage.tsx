// src/pages/financeiro/PaineisTvPage.tsx — Gerenciamento de Painéis TV
import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ExternalLink, Plus, Pencil, Trash2, Save, X, Tv, Users, BarChart3, RotateCcw, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import toast from 'react-hot-toast';

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

interface MetaTecnico {
  id: string;
  nome_tecnico: string;
  meta_faturamento: number;
  ativo: boolean;
}

const TV_PANELS = [
  {
    title: 'Resultados Operação',
    description: 'Resumo geral de receitas, custos e margem líquida do mês',
    icon: BarChart3,
    path: '/tv/resultados',
  },
  {
    title: 'Metas por Técnico',
    description: 'Atingimento individual de meta de faturamento por técnico',
    icon: Users,
    path: '/tv/tecnicos',
  },
];

export default function PaineisTvPage() {
  const queryClient = useQueryClient();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState({ nome_tecnico: '', meta_faturamento: '' });
  const [showAdd, setShowAdd] = useState(false);
  const [addValues, setAddValues] = useState({ nome_tecnico: '', meta_faturamento: '' });

  const { data: metas = [], isLoading } = useQuery({
    queryKey: ['fin_metas_tecnicos_admin'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_metas_tecnicos')
        .select('*')
        .order('nome_tecnico');
      if (error) throw error;
      return data as MetaTecnico[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['fin_metas_tecnicos_admin'] });

  const toggleAtivo = useMutation({
    mutationFn: async ({ id, ativo }: { id: string; ativo: boolean }) => {
      const { error } = await supabase.from('fin_metas_tecnicos').update({ ativo }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success('Atualizado'); },
    onError: () => toast.error('Erro ao atualizar'),
  });

  const updateMeta = useMutation({
    mutationFn: async ({ id, nome_tecnico, meta_faturamento }: { id: string; nome_tecnico: string; meta_faturamento: number }) => {
      const { error } = await supabase.from('fin_metas_tecnicos').update({ nome_tecnico, meta_faturamento }).eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); setEditingId(null); toast.success('Meta atualizada'); },
    onError: () => toast.error('Erro ao atualizar'),
  });

  const addMeta = useMutation({
    mutationFn: async ({ nome_tecnico, meta_faturamento }: { nome_tecnico: string; meta_faturamento: number }) => {
      const { error } = await supabase.from('fin_metas_tecnicos').insert({ nome_tecnico, meta_faturamento });
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); setShowAdd(false); setAddValues({ nome_tecnico: '', meta_faturamento: '' }); toast.success('Técnico adicionado'); },
    onError: () => toast.error('Erro ao adicionar'),
  });

  const deleteMeta = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('fin_metas_tecnicos').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => { invalidate(); toast.success('Removido'); },
    onError: () => toast.error('Erro ao remover'),
  });

  const startEdit = (m: MetaTecnico) => {
    setEditingId(m.id);
    setEditValues({ nome_tecnico: m.nome_tecnico, meta_faturamento: String(m.meta_faturamento) });
  };

  const saveEdit = () => {
    if (!editingId || !editValues.nome_tecnico.trim()) return;
    updateMeta.mutate({ id: editingId, nome_tecnico: editValues.nome_tecnico.trim(), meta_faturamento: Number(editValues.meta_faturamento) || 0 });
  };

  const baseUrl = window.location.origin;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground">📺 Painéis TV</h1>
        <p className="text-muted-foreground mt-1">Gerencie os dashboards de projeção e metas dos técnicos</p>
      </div>

      {/* Links dos Painéis */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {TV_PANELS.map(panel => (
          <Card key={panel.path} className="border-border">
            <CardContent className="p-5 flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="h-12 w-12 rounded-xl bg-primary/10 flex items-center justify-center">
                  <panel.icon className="h-6 w-6 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground">{panel.title}</h3>
                  <p className="text-sm text-muted-foreground">{panel.description}</p>
                  <code className="text-xs text-muted-foreground/60 mt-1 block">{baseUrl}{panel.path}</code>
                </div>
              </div>
              <Button variant="outline" size="sm" asChild>
                <a href={panel.path} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4 mr-1" /> Abrir
                </a>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Metas dos Técnicos */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <CardTitle className="text-lg">Metas de Faturamento por Técnico</CardTitle>
          <Button size="sm" onClick={() => setShowAdd(true)}>
            <Plus className="h-4 w-4 mr-1" /> Adicionar
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Técnico</TableHead>
                <TableHead className="text-right">Meta Mensal</TableHead>
                <TableHead className="text-center">Ativo</TableHead>
                <TableHead className="text-right w-[120px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metas.map(m => (
                <TableRow key={m.id}>
                  <TableCell>
                    {editingId === m.id ? (
                      <Input
                        value={editValues.nome_tecnico}
                        onChange={e => setEditValues(v => ({ ...v, nome_tecnico: e.target.value }))}
                        className="h-8 w-40"
                      />
                    ) : (
                      <span className="font-medium">{m.nome_tecnico}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {editingId === m.id ? (
                      <Input
                        type="number"
                        value={editValues.meta_faturamento}
                        onChange={e => setEditValues(v => ({ ...v, meta_faturamento: e.target.value }))}
                        className="h-8 w-32 ml-auto text-right"
                      />
                    ) : (
                      formatBRL(m.meta_faturamento)
                    )}
                  </TableCell>
                  <TableCell className="text-center">
                    <Switch
                      checked={m.ativo}
                      onCheckedChange={ativo => toggleAtivo.mutate({ id: m.id, ativo })}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    {editingId === m.id ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={saveEdit}>
                          <Save className="h-4 w-4 text-emerald-500" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-end gap-1">
                        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => startEdit(m)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-8 w-8"
                          onClick={() => { if (confirm(`Remover ${m.nome_tecnico}?`)) deleteMeta.mutate(m.id); }}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {metas.length === 0 && !isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Nenhum técnico cadastrado
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dialog Adicionar */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adicionar Técnico</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Nome (primeiro nome, como aparece na OS)</Label>
              <Input
                value={addValues.nome_tecnico}
                onChange={e => setAddValues(v => ({ ...v, nome_tecnico: e.target.value }))}
                placeholder="Ex: ELTON"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Meta de Faturamento Mensal (R$)</Label>
              <Input
                type="number"
                value={addValues.meta_faturamento}
                onChange={e => setAddValues(v => ({ ...v, meta_faturamento: e.target.value }))}
                placeholder="Ex: 30550"
                className="mt-1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>Cancelar</Button>
            <Button
              onClick={() => {
                if (!addValues.nome_tecnico.trim()) return toast.error('Informe o nome');
                addMeta.mutate({ nome_tecnico: addValues.nome_tecnico.trim(), meta_faturamento: Number(addValues.meta_faturamento) || 0 });
              }}
            >
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
