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
  const [showRetorno, setShowRetorno] = useState(false);
  const [retornoValues, setRetornoValues] = useState({ os_codigo: '', tecnico_original: '', tecnico_retorno: '', valor: '' });

  // Month navigation for retornos
  const now = new Date();
  const [retornoDate, setRetornoDate] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });

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

  // Retornos query
  const { data: retornos = [] } = useQuery({
    queryKey: ['fin_os_retornos_admin', retornoDate.year, retornoDate.month],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_os_retornos')
        .select('*')
        .eq('ano', retornoDate.year)
        .eq('mes', retornoDate.month)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data as any[];
    },
  });

  const invalidateRetornos = () => queryClient.invalidateQueries({ queryKey: ['fin_os_retornos_admin', retornoDate.year, retornoDate.month] });

  const addRetorno = useMutation({
    mutationFn: async (params: { os_codigo: string; tecnico_original: string; tecnico_retorno: string; valor: number }) => {
      const { error } = await supabase.from('fin_os_retornos').insert({
        os_codigo: params.os_codigo,
        tecnico_original: params.tecnico_original.toUpperCase(),
        tecnico_retorno: params.tecnico_retorno.toUpperCase(),
        valor: params.valor,
        ano: retornoDate.year,
        mes: retornoDate.month,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateRetornos();
      queryClient.invalidateQueries({ queryKey: ['fin_os_retornos'] });
      setShowRetorno(false);
      setRetornoValues({ os_codigo: '', tecnico_original: '', tecnico_retorno: '', valor: '' });
      toast.success('Retorno registrado');
    },
    onError: (e: any) => toast.error(e.message || 'Erro ao registrar retorno'),
  });

  const deleteRetorno = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('fin_os_retornos').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidateRetornos();
      queryClient.invalidateQueries({ queryKey: ['fin_os_retornos'] });
      toast.success('Retorno removido');
    },
    onError: () => toast.error('Erro ao remover'),
  });

  const tecnicosAtivos = metas.filter(m => m.ativo).map(m => m.nome_tecnico);

  const navigateRetornoMonth = (dir: number) => {
    setRetornoDate(prev => {
      let m = prev.month + dir;
      let y = prev.year;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      return { year: y, month: m };
    });
  };

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

      {/* Retornos de OS */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-4">
          <div className="flex items-center gap-3">
            <CardTitle className="text-lg flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-orange-500" />
              Retornos de OS
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigateRetornoMonth(-1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground min-w-[130px] text-center">
                {meses[retornoDate.month - 1]} {retornoDate.year}
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigateRetornoMonth(1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <Button size="sm" variant="outline" onClick={() => setShowRetorno(true)}>
            <Plus className="h-4 w-4 mr-1" /> Lançar Retorno
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>OS</TableHead>
                <TableHead>Técnico Original</TableHead>
                <TableHead>Técnico Retorno</TableHead>
                <TableHead className="text-right">Valor</TableHead>
                <TableHead className="text-right w-[80px]">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retornos.map((r: any) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono font-medium">{r.os_codigo}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-muted-foreground">{r.tecnico_original}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge className="bg-orange-500/10 text-orange-600 border-orange-500/20">{r.tecnico_retorno}</Badge>
                  </TableCell>
                  <TableCell className="text-right">{formatBRL(r.valor)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8"
                      onClick={() => { if (confirm(`Remover retorno da OS ${r.os_codigo}?`)) deleteRetorno.mutate(r.id); }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {retornos.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    Nenhum retorno registrado neste mês
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Dialog Lançar Retorno */}
      <Dialog open={showRetorno} onOpenChange={setShowRetorno}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <RotateCcw className="h-5 w-5 text-orange-500" />
              Lançar Retorno
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Código da OS</Label>
              <Input
                value={retornoValues.os_codigo}
                onChange={e => setRetornoValues(v => ({ ...v, os_codigo: e.target.value }))}
                placeholder="Ex: 12345"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Valor (R$)</Label>
              <Input
                type="number"
                value={retornoValues.valor}
                onChange={e => setRetornoValues(v => ({ ...v, valor: e.target.value }))}
                placeholder="Ex: 1500"
                className="mt-1"
              />
            </div>
            <div>
              <Label>Técnico Original (quem fez a OS)</Label>
              <Select
                value={retornoValues.tecnico_original}
                onValueChange={v => setRetornoValues(prev => ({ ...prev, tecnico_original: v }))}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Selecione..." />
                </SelectTrigger>
                <SelectContent>
                  {tecnicosAtivos.map(t => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Técnico que atendeu o retorno</Label>
              <Select
                value={retornoValues.tecnico_retorno}
                onValueChange={v => setRetornoValues(prev => ({ ...prev, tecnico_retorno: v }))}
              >
                <SelectTrigger className="mt-1">
                  <SelectValue placeholder="Selecione..." />
                </SelectTrigger>
                <SelectContent>
                  {tecnicosAtivos
                    .filter(t => t !== retornoValues.tecnico_original)
                    .map(t => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRetorno(false)}>Cancelar</Button>
            <Button
              className="bg-orange-500 hover:bg-orange-600"
              onClick={() => {
                if (!retornoValues.os_codigo.trim()) return toast.error('Informe o código da OS');
                if (!retornoValues.tecnico_original) return toast.error('Selecione o técnico original');
                if (!retornoValues.tecnico_retorno) return toast.error('Selecione o técnico do retorno');
                addRetorno.mutate({
                  os_codigo: retornoValues.os_codigo.trim(),
                  tecnico_original: retornoValues.tecnico_original,
                  tecnico_retorno: retornoValues.tecnico_retorno,
                  valor: Number(retornoValues.valor) || 0,
                });
              }}
            >
              Confirmar Retorno
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
