import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Plus, Trash2, Save, Loader2, X } from 'lucide-react';
import toast from 'react-hot-toast';

interface Meta {
  id: string;
  nome: string;
  categoria: 'receita' | 'custo_variavel' | 'custo_fixo';
  tipo_meta: 'absoluto' | 'percentual';
  meta_valor: number | null;
  meta_percentual: number | null;
  ativo: boolean;
}

interface Mapeamento {
  id: string;
  meta_id: string;
  plano_contas_id: string;
  centro_custo_id: string | null;
  nome_plano: string | null;
  nome_centro_custo: string | null;
  peso: number;
}

interface PlanoContas {
  id: string;
  nome: string;
  gc_id: string | null;
}

interface CentroCusto {
  id: string;
  nome: string;
  codigo: string | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const categoriaLabel: Record<string, string> = {
  receita: 'Receita',
  custo_variavel: 'Custo Variável',
  custo_fixo: 'Custo Fixo',
};

const categoriaColor: Record<string, string> = {
  receita: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  custo_variavel: 'bg-blue-100 text-blue-800 border-blue-200',
  custo_fixo: 'bg-red-100 text-red-800 border-red-200',
};

export default function MetasConfigDialog({ open, onOpenChange }: Props) {
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [editingMeta, setEditingMeta] = useState<Meta | null>(null);
  const [editingMaps, setEditingMaps] = useState<Mapeamento[]>([]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newMeta, setNewMeta] = useState<Partial<Meta>>({
    nome: '', categoria: 'custo_fixo', tipo_meta: 'absoluto', meta_valor: 0, meta_percentual: null, ativo: true,
  });

  // Fetch metas
  const { data: metas = [], refetch: refetchMetas } = useQuery({
    queryKey: ['config_fin_metas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_metas').select('*').order('categoria').order('nome');
      if (error) throw error;
      return data as Meta[];
    },
    enabled: open,
  });

  // Fetch mapeamentos
  const { data: mapeamentos = [], refetch: refetchMaps } = useQuery({
    queryKey: ['config_fin_meta_plano_contas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_meta_plano_contas').select('*');
      if (error) throw error;
      return data as Mapeamento[];
    },
    enabled: open,
  });

  // Fetch planos de contas
  const { data: planos = [] } = useQuery({
    queryKey: ['config_plano_contas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_plano_contas').select('id, nome, gc_id').eq('ativo', true).order('nome');
      if (error) throw error;
      return data as PlanoContas[];
    },
    enabled: open,
  });

  // Fetch centros de custo
  const { data: centros = [] } = useQuery({
    queryKey: ['config_centros_custo'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_centros_custo').select('id, nome, codigo').eq('ativo', true).order('nome');
      if (error) throw error;
      return data as CentroCusto[];
    },
    enabled: open,
  });

  // When selecting a meta to edit, load its mappings
  const handleEditMeta = (meta: Meta) => {
    setEditingMeta({ ...meta });
    setEditingMaps(mapeamentos.filter(m => m.meta_id === meta.id).map(m => ({ ...m })));
    setShowNewForm(false);
  };

  const handleAddMapping = () => {
    if (!editingMeta) return;
    setEditingMaps(prev => [...prev, {
      id: `new_${Date.now()}`,
      meta_id: editingMeta.id,
      plano_contas_id: '',
      centro_custo_id: null,
      nome_plano: null,
      nome_centro_custo: null,
      peso: 1,
    }]);
  };

  const handleRemoveMapping = (idx: number) => {
    setEditingMaps(prev => prev.filter((_, i) => i !== idx));
  };

  const handleSaveMeta = async () => {
    if (!editingMeta) return;
    setSaving(true);
    try {
      // Update meta
      const { error: metaErr } = await supabase.from('fin_metas').update({
        nome: editingMeta.nome,
        categoria: editingMeta.categoria,
        tipo_meta: editingMeta.tipo_meta,
        meta_valor: editingMeta.meta_valor,
        meta_percentual: editingMeta.meta_percentual,
        ativo: editingMeta.ativo,
      }).eq('id', editingMeta.id);
      if (metaErr) throw metaErr;

      // Delete existing mappings
      await supabase.from('fin_meta_plano_contas').delete().eq('meta_id', editingMeta.id);

      // Insert new mappings
      const validMaps = editingMaps.filter(m => m.plano_contas_id);
      if (validMaps.length > 0) {
        const planoMap = Object.fromEntries(planos.map(p => [p.id, p.nome]));
        const centroMap = Object.fromEntries(centros.map(c => [c.id, c.nome]));

        const inserts = validMaps.map(m => ({
          meta_id: editingMeta.id,
          plano_contas_id: m.plano_contas_id, // UUID
          centro_custo_id: m.centro_custo_id || null, // UUID
          nome_plano: planoMap[m.plano_contas_id] || m.nome_plano || null,
          nome_centro_custo: m.centro_custo_id ? (centroMap[m.centro_custo_id] || m.nome_centro_custo || null) : null,
          peso: m.peso || 1,
        }));
        const { error: mapErr } = await supabase.from('fin_meta_plano_contas').insert(inserts);
        if (mapErr) throw mapErr;
      }

      toast.success('Meta salva com sucesso');
      refetchMetas();
      refetchMaps();
      queryClient.invalidateQueries({ queryKey: ['fin_metas'] });
      queryClient.invalidateQueries({ queryKey: ['fin_meta_plano_contas'] });
      setEditingMeta(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateMeta = async () => {
    if (!newMeta.nome) { toast.error('Nome é obrigatório'); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from('fin_metas').insert({
        nome: newMeta.nome!,
        categoria: newMeta.categoria!,
        tipo_meta: newMeta.tipo_meta!,
        meta_valor: newMeta.tipo_meta === 'absoluto' ? newMeta.meta_valor : null,
        meta_percentual: newMeta.tipo_meta === 'percentual' ? newMeta.meta_percentual : null,
        ativo: true,
      });
      if (error) throw error;
      toast.success('Meta criada');
      setShowNewForm(false);
      setNewMeta({ nome: '', categoria: 'custo_fixo', tipo_meta: 'absoluto', meta_valor: 0, meta_percentual: null, ativo: true });
      refetchMetas();
      queryClient.invalidateQueries({ queryKey: ['fin_metas'] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteMeta = async (id: string) => {
    if (!confirm('Tem certeza que deseja excluir esta meta?')) return;
    try {
      await supabase.from('fin_meta_plano_contas').delete().eq('meta_id', id);
      await supabase.from('fin_metas').delete().eq('id', id);
      toast.success('Meta excluída');
      if (editingMeta?.id === id) setEditingMeta(null);
      refetchMetas();
      refetchMaps();
      queryClient.invalidateQueries({ queryKey: ['fin_metas'] });
      queryClient.invalidateQueries({ queryKey: ['fin_meta_plano_contas'] });
    } catch (err) {
      toast.error('Erro ao excluir');
    }
  };

  const grouped = {
    receita: metas.filter(m => m.categoria === 'receita'),
    custo_variavel: metas.filter(m => m.categoria === 'custo_variavel'),
    custo_fixo: metas.filter(m => m.categoria === 'custo_fixo'),
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Configurar Metas & Orçamento</DialogTitle>
        </DialogHeader>

        <div className="flex gap-4 flex-1 min-h-0">
          {/* LEFT: Lista de metas */}
          <div className="w-1/2 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-medium text-foreground">Metas ({metas.length})</span>
              <Button size="sm" variant="outline" onClick={() => { setShowNewForm(true); setEditingMeta(null); }}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Nova
              </Button>
            </div>
            <ScrollArea className="flex-1 pr-2">
              <Accordion type="multiple" defaultValue={['receita', 'custo_variavel', 'custo_fixo']} className="space-y-1">
                {(['receita', 'custo_variavel', 'custo_fixo'] as const).map(cat => (
                  <AccordionItem key={cat} value={cat} className="border rounded-md px-2">
                    <AccordionTrigger className="text-xs font-semibold hover:no-underline py-2">
                      <span className="flex items-center gap-2">
                        <Badge variant="outline" className={`text-[10px] ${categoriaColor[cat]}`}>
                          {categoriaLabel[cat]}
                        </Badge>
                        <span className="text-muted-foreground">({grouped[cat].length})</span>
                      </span>
                    </AccordionTrigger>
                    <AccordionContent className="space-y-1 pb-2">
                      {grouped[cat].map(meta => {
                        const maps = mapeamentos.filter(m => m.meta_id === meta.id);
                        const isSelected = editingMeta?.id === meta.id;
                        return (
                          <div
                            key={meta.id}
                            onClick={() => handleEditMeta(meta)}
                            className={`p-2 rounded cursor-pointer text-xs flex items-center justify-between gap-1 transition-colors ${
                              isSelected ? 'bg-primary/10 border border-primary/30' : 'hover:bg-accent/50'
                            } ${!meta.ativo ? 'opacity-50' : ''}`}
                          >
                            <div className="min-w-0">
                              <span className="font-medium block truncate">{meta.nome}</span>
                              <span className="text-muted-foreground text-[10px]">
                                {meta.tipo_meta === 'absoluto'
                                  ? `R$ ${(meta.meta_valor || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                                  : `${((meta.meta_percentual || 0) * 100).toFixed(1)}%`
                                }
                                {' · '}{maps.length} plano(s)
                              </span>
                            </div>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 shrink-0"
                              onClick={(e) => { e.stopPropagation(); handleDeleteMeta(meta.id); }}
                            >
                              <Trash2 className="h-3 w-3 text-destructive" />
                            </Button>
                          </div>
                        );
                      })}
                    </AccordionContent>
                  </AccordionItem>
                ))}
              </Accordion>
            </ScrollArea>
          </div>

          {/* RIGHT: Editor */}
          <div className="w-1/2 flex flex-col min-h-0 border-l pl-4">
            {showNewForm ? (
              <ScrollArea className="flex-1">
                <h3 className="text-sm font-semibold mb-3">Nova Meta</h3>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">Nome</Label>
                    <Input value={newMeta.nome || ''} onChange={e => setNewMeta(p => ({ ...p, nome: e.target.value }))} />
                  </div>
                  <div>
                    <Label className="text-xs">Categoria</Label>
                    <Select value={newMeta.categoria} onValueChange={v => setNewMeta(p => ({ ...p, categoria: v as any }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="receita">Receita</SelectItem>
                        <SelectItem value="custo_variavel">Custo Variável</SelectItem>
                        <SelectItem value="custo_fixo">Custo Fixo</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">Tipo de Meta</Label>
                    <Select value={newMeta.tipo_meta} onValueChange={v => setNewMeta(p => ({ ...p, tipo_meta: v as any }))}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="absoluto">Valor Absoluto (R$)</SelectItem>
                        <SelectItem value="percentual">Percentual do Faturamento (%)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {newMeta.tipo_meta === 'absoluto' ? (
                    <div>
                      <Label className="text-xs">Valor da Meta (R$)</Label>
                      <Input type="number" step="0.01" value={newMeta.meta_valor || 0} onChange={e => setNewMeta(p => ({ ...p, meta_valor: parseFloat(e.target.value) || 0 }))} />
                    </div>
                  ) : (
                    <div>
                      <Label className="text-xs">Percentual (%)</Label>
                      <Input type="number" step="0.1" value={((newMeta.meta_percentual || 0) * 100)} onChange={e => setNewMeta(p => ({ ...p, meta_percentual: (parseFloat(e.target.value) || 0) / 100 }))} />
                    </div>
                  )}
                  <div className="flex gap-2 pt-2">
                    <Button size="sm" onClick={handleCreateMeta} disabled={saving}>
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                      Criar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setShowNewForm(false)}>Cancelar</Button>
                  </div>
                </div>
              </ScrollArea>
            ) : editingMeta ? (
              <ScrollArea className="flex-1">
                <h3 className="text-sm font-semibold mb-3">Editar: {editingMeta.nome}</h3>
                <div className="space-y-3">
                  <div>
                    <Label className="text-xs">Nome</Label>
                    <Input value={editingMeta.nome} onChange={e => setEditingMeta(p => p ? { ...p, nome: e.target.value } : p)} />
                  </div>
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <Label className="text-xs">Categoria</Label>
                      <Select value={editingMeta.categoria} onValueChange={v => setEditingMeta(p => p ? { ...p, categoria: v as any } : p)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="receita">Receita</SelectItem>
                          <SelectItem value="custo_variavel">Custo Variável</SelectItem>
                          <SelectItem value="custo_fixo">Custo Fixo</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex-1">
                      <Label className="text-xs">Tipo de Meta</Label>
                      <Select value={editingMeta.tipo_meta} onValueChange={v => setEditingMeta(p => p ? { ...p, tipo_meta: v as any } : p)}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="absoluto">Absoluto (R$)</SelectItem>
                          <SelectItem value="percentual">Percentual (%)</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  {editingMeta.tipo_meta === 'absoluto' ? (
                    <div>
                      <Label className="text-xs">Valor da Meta (R$)</Label>
                      <Input type="number" step="0.01" value={editingMeta.meta_valor || 0}
                        onChange={e => setEditingMeta(p => p ? { ...p, meta_valor: parseFloat(e.target.value) || 0 } : p)} />
                    </div>
                  ) : (
                    <div>
                      <Label className="text-xs">Percentual (%)</Label>
                      <Input type="number" step="0.1" value={((editingMeta.meta_percentual || 0) * 100)}
                        onChange={e => setEditingMeta(p => p ? { ...p, meta_percentual: (parseFloat(e.target.value) || 0) / 100 } : p)} />
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <Switch checked={editingMeta.ativo} onCheckedChange={v => setEditingMeta(p => p ? { ...p, ativo: v } : p)} />
                    <Label className="text-xs">Ativa</Label>
                  </div>

                  {/* Mapeamentos */}
                  <div className="pt-2 border-t">
                    <div className="flex items-center justify-between mb-2">
                      <Label className="text-xs font-semibold">Planos de Conta Vinculados</Label>
                      <Button size="sm" variant="outline" onClick={handleAddMapping} className="h-6 text-xs px-2">
                        <Plus className="h-3 w-3 mr-1" /> Adicionar
                      </Button>
                    </div>
                    <div className="space-y-2">
                      {editingMaps.map((map, idx) => (
                        <div key={map.id} className="flex items-start gap-1 p-2 rounded bg-muted/50 border text-xs">
                          <div className="flex-1 space-y-1.5">
                            <div>
                              <Label className="text-[10px] text-muted-foreground">Plano de Contas (GC ID)</Label>
                              <Select
                                value={map.plano_contas_id}
                                onValueChange={v => {
                                  const plano = planos.find(p => p.gc_id === v);
                                  setEditingMaps(prev => prev.map((m, i) => i === idx ? { ...m, plano_contas_id: v, nome_plano: plano?.nome || null } : m));
                                }}
                              >
                                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                                <SelectContent>
                                  {planos.filter(p => p.gc_id).map(p => (
                                    <SelectItem key={p.gc_id!} value={p.gc_id!} className="text-xs">{p.nome}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <Label className="text-[10px] text-muted-foreground">Centro de Custo</Label>
                              <Select
                                value={map.centro_custo_id || '__none__'}
                                onValueChange={v => {
                                  const val = v === '__none__' ? null : v;
                                  const centro = centros.find(c => c.codigo === val);
                                  setEditingMaps(prev => prev.map((m, i) => i === idx ? { ...m, centro_custo_id: val, nome_centro_custo: centro?.nome || null } : m));
                                }}
                              >
                                <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Todos" /></SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="__none__" className="text-xs">Todos</SelectItem>
                                  {centros.filter(c => c.codigo).map(c => (
                                    <SelectItem key={c.codigo!} value={c.codigo!} className="text-xs">{c.nome}</SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div>
                              <Label className="text-[10px] text-muted-foreground">Peso</Label>
                              <Input type="number" step="0.1" className="h-7 text-xs w-20" value={map.peso}
                                onChange={e => setEditingMaps(prev => prev.map((m, i) => i === idx ? { ...m, peso: parseFloat(e.target.value) || 1 } : m))} />
                            </div>
                          </div>
                          <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0 mt-4" onClick={() => handleRemoveMapping(idx)}>
                            <X className="h-3 w-3 text-destructive" />
                          </Button>
                        </div>
                      ))}
                      {editingMaps.length === 0 && (
                        <p className="text-xs text-muted-foreground italic">Nenhum plano vinculado. Adicione para calcular o realizado.</p>
                      )}
                    </div>
                  </div>

                  <div className="flex gap-2 pt-3 sticky bottom-0 bg-background pb-2">
                    <Button size="sm" onClick={handleSaveMeta} disabled={saving}>
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Save className="h-3.5 w-3.5 mr-1" />}
                      Salvar
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditingMeta(null)}>Cancelar</Button>
                  </div>
                </div>
              </ScrollArea>
            ) : (
              <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
                Selecione uma meta para editar ou crie uma nova.
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
