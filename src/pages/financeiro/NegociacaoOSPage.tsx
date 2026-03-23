import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { callGC } from "@/lib/gc-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, HandshakeIcon, AlertCircle, CheckCircle2, ArrowLeft, Settings2, Banknote } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import toast from "react-hot-toast";

interface ResidualItem {
  id: string;
  valor_residual: number;
  negociacao_origem_numero: number | null;
  observacao: string | null;
  created_at: string | null;
}

interface OSItem {
  id: string;
  codigo: string;
  descricao: string;
  valor_total: number;
  nome_cliente: string;
  data: string;
  nome_situacao: string;
}

interface ClientGroup {
  cliente_id: string;
  nome_cliente: string;
  os_list: OSItem[];
  valor_total: number;
}

interface NegotiateResult {
  os_id: string;
  status: string;
  error?: string;
}

interface GCSituacao {
  id: string;
  nome: string;
}

const CONFIG_KEY = "negociacao_situacao_ids";
const DEFAULT_SITUACAO = "7116099"; // Executado - Ag Negociação Financeira

export default function NegociacaoOSPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [clients, setClients] = useState<ClientGroup[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientGroup | null>(null);
  const [selectedOSIds, setSelectedOSIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");

  // Config
  const [showConfig, setShowConfig] = useState(false);
  const [situacoes, setSituacoes] = useState<GCSituacao[]>([]);
  const [selectedSituacoes, setSelectedSituacoes] = useState<string[]>([DEFAULT_SITUACAO]);
  const [loadingSituacoes, setLoadingSituacoes] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Negotiation params
  const [showNegotiate, setShowNegotiate] = useState(false);
  const [parcelas, setParcelas] = useState(10);
  const [diaVencimento, setDiaVencimento] = useState(10);
  const [mesInicio, setMesInicio] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
  const [valoresParcelas, setValoresParcelas] = useState<number[]>([]);
  const [valorNegociado, setValorNegociado] = useState<number>(0);

  // Residuals
  const [clientResiduais, setClientResiduais] = useState<ResidualItem[]>([]);

  // Results
  const [results, setResults] = useState<NegotiateResult[] | null>(null);

  // Load saved config
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("fin_configuracoes")
        .select("valor")
        .eq("chave", CONFIG_KEY)
        .maybeSingle();
      if (data?.valor) {
        try {
          const ids = JSON.parse(data.valor) as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            setSelectedSituacoes(ids);
          }
        } catch { /* ignore */ }
      }
    })();
  }, []);

  const fetchOS = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("negotiate-os", {
        body: { action: "list", situacao_ids: selectedSituacoes },
      });
      if (error) throw error;
      const groupedClients = (data.clients || [])
        .map((c: ClientGroup) => {
          const osList = c.os_list.filter((os) => os.valor_total > 0);
          const valorTotal = osList.reduce((sum, os) => sum + os.valor_total, 0);
          return { ...c, os_list: osList, valor_total: valorTotal };
        })
        .filter((c: ClientGroup) => c.os_list.length > 1 && c.valor_total > 0);
      setClients(groupedClients);
      if (groupedClients.length === 0) {
        toast("Nenhum cliente com 2+ OS nas situações selecionadas", { icon: "ℹ️" });
      }
    } catch (err) {
      toast.error(`Erro ao buscar OS: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [selectedSituacoes]);

  useEffect(() => {
    fetchOS();
  }, [fetchOS]);

  const fetchSituacoes = async () => {
    setLoadingSituacoes(true);
    try {
      const res = await callGC<{ data: GCSituacao[] }>({
        endpoint: "/api/situacoes_ordens_servicos",
        params: { limite: "200", pagina: "1" },
      });
      const items = Array.isArray(res.data?.data) ? res.data.data : [];
      setSituacoes(items.map((s: any) => ({ id: String(s.id), nome: String(s.nome || s.id) })));
    } catch (err) {
      toast.error("Erro ao carregar situações do GestãoClick");
    } finally {
      setLoadingSituacoes(false);
    }
  };

  const handleOpenConfig = () => {
    setShowConfig(true);
    if (situacoes.length === 0) fetchSituacoes();
  };

  const toggleSituacao = (id: string) => {
    setSelectedSituacoes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const handleSaveConfig = async () => {
    if (selectedSituacoes.length === 0) {
      toast.error("Selecione ao menos uma situação");
      return;
    }
    setSavingConfig(true);
    try {
      const { error } = await supabase
        .from("fin_configuracoes")
        .upsert(
          { chave: CONFIG_KEY, valor: JSON.stringify(selectedSituacoes), updated_at: new Date().toISOString() },
          { onConflict: "chave" }
        );
      if (error) throw error;
      toast.success("Configuração salva!");
      setShowConfig(false);
      fetchOS();
    } catch (err) {
      toast.error("Erro ao salvar configuração");
    } finally {
      setSavingConfig(false);
    }
  };

  const filteredClients = clients.filter((c) =>
    c.nome_cliente.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelectClient = async (client: ClientGroup) => {
    setSelectedClient(client);
    setSelectedOSIds(new Set(client.os_list.map((os) => os.id)));
    // Fetch residuals for this client
    const { data } = await supabase
      .from("fin_residuos_negociacao")
      .select("*")
      .eq("cliente_gc_id", client.cliente_id)
      .eq("utilizado", false)
      .order("created_at", { ascending: false });
    setClientResiduais((data as ResidualItem[]) || []);
  };

  const handleBack = () => {
    if (selectedClient) {
      setSelectedClient(null);
      setSelectedOSIds(new Set());
      return;
    }
    navigate(-1);
  };

  const toggleOS = (osId: string) => {
    setSelectedOSIds((prev) => {
      const next = new Set(prev);
      if (next.has(osId)) next.delete(osId);
      else next.add(osId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!selectedClient) return;
    if (selectedOSIds.size === selectedClient.os_list.length) {
      setSelectedOSIds(new Set());
    } else {
      setSelectedOSIds(new Set(selectedClient.os_list.map((os) => os.id)));
    }
  };

  const selectedTotal = selectedClient?.os_list
    .filter((os) => selectedOSIds.has(os.id))
    .reduce((sum, os) => sum + os.valor_total, 0) || 0;

  const valorParcela = parcelas > 0 ? valorNegociado / parcelas : 0;
  const valorResidual = Math.round((selectedTotal - valorNegociado) * 100) / 100;

  // Reset valorNegociado when selectedTotal changes
  useEffect(() => {
    setValorNegociado(selectedTotal);
  }, [selectedTotal]);

  // Initialize parcela values when params change
  useEffect(() => {
    if (parcelas > 0 && valorNegociado > 0) {
      const base = Math.round((valorNegociado / parcelas) * 100) / 100;
      const arr = Array(parcelas).fill(base);
      const diff = Math.round((valorNegociado - arr.reduce((a: number, b: number) => a + b, 0)) * 100) / 100;
      arr[arr.length - 1] = Math.round((arr[arr.length - 1] + diff) * 100) / 100;
      setValoresParcelas(arr);
    }
  }, [parcelas, valorNegociado]);

  const handleParcelaValueChange = (index: number, newValue: number) => {
    const updated = [...valoresParcelas];
    updated[index] = Math.round(newValue * 100) / 100;
    const remaining = valorNegociado - updated[index];
    const othersCount = updated.length - 1;
    if (othersCount > 0 && remaining >= 0) {
      const eachOther = Math.round((remaining / othersCount) * 100) / 100;
      for (let i = 0; i < updated.length; i++) {
        if (i !== index) updated[i] = eachOther;
      }
      const totalNow = updated.reduce((a, b) => a + b, 0);
      const roundDiff = Math.round((valorNegociado - totalNow) * 100) / 100;
      if (roundDiff !== 0) {
        const lastOther = index === updated.length - 1 ? updated.length - 2 : updated.length - 1;
        updated[lastOther] = Math.round((updated[lastOther] + roundDiff) * 100) / 100;
      }
    }
    setValoresParcelas(updated);
  };

  const handleExecute = async () => {
    if (selectedOSIds.size === 0) return;
    setExecuting(true);
    setResults(null);

    try {
      const { data, error } = await supabase.functions.invoke("negotiate-os", {
        body: {
          action: "execute",
          os_ids: Array.from(selectedOSIds),
          parcelas,
          dia_vencimento: diaVencimento,
          mes_inicio: mesInicio,
          valores_parcelas: valoresParcelas,
          valor_negociado: valorNegociado,
          valor_residual: valorResidual > 0.01 ? valorResidual : 0,
          nome_cliente: selectedClient?.nome_cliente,
          cliente_gc_id: selectedClient?.cliente_id,
        },
      });

      if (error) throw error;
      setResults(data.results || []);

      const ok = data.summary?.ok || 0;
      const errs = data.summary?.errors || 0;

      if (errs === 0) {
        toast.success(`✅ ${ok} OS negociada(s) com sucesso!`);
      } else {
        toast.error(`${ok} OK, ${errs} erro(s). Verifique os resultados.`);
      }
    } catch (err) {
      toast.error(`Erro: ${(err as Error).message}`);
    } finally {
      setExecuting(false);
    }
  };

  const handleCloseResults = () => {
    setResults(null);
    setShowNegotiate(false);
    setSelectedClient(null);
    setSelectedOSIds(new Set());
    fetchOS();
  };

  const formatCurrency = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  // Generate preview dates
  const previewDates = (() => {
    if (!mesInicio || !parcelas) return [];
    const [y, m] = mesInicio.split("-").map(Number);
    const dates: string[] = [];
    for (let i = 0; i < Math.min(parcelas, 24); i++) {
      const d = new Date(y, m - 1 + i, diaVencimento);
      dates.push(d.toLocaleDateString("pt-BR"));
    }
    return dates;
  })();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <HandshakeIcon className="h-6 w-6" />
              Negociação de OS
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              OS agrupadas por cliente ({selectedSituacoes.length} situação(ões) configurada(s))
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={handleOpenConfig} variant="outline" size="sm">
            <Settings2 className="h-4 w-4 mr-1" />
            Situações
          </Button>
          <Button onClick={fetchOS} disabled={loading} variant="outline" size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Atualizar
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar cliente..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !selectedClient ? (
        /* Client list */
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredClients.map((client) => (
            <Card
              key={client.cliente_id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => handleSelectClient(client)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium truncate">
                  {client.nome_cliente}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <Badge variant="secondary">{client.os_list.length} OS</Badge>
                  <span className="text-sm font-semibold text-primary">
                    {formatCurrency(client.valor_total)}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
          {filteredClients.length === 0 && !loading && (
            <p className="text-muted-foreground col-span-full text-center py-10">
              Nenhum cliente com OS pendente de negociação.
            </p>
          )}
        </div>
      ) : (
        /* OS list for selected client */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Button variant="ghost" size="sm" onClick={handleBack}>
                ← Voltar
              </Button>
              <span className="ml-2 font-semibold text-foreground">{selectedClient.nome_cliente}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {selectedOSIds.size} selecionada(s) · {formatCurrency(selectedTotal)}
              </span>
              <Button
                onClick={() => setShowNegotiate(true)}
                disabled={selectedOSIds.size === 0}
                size="sm"
              >
                <HandshakeIcon className="h-4 w-4 mr-2" />
                Negociar
              </Button>
            </div>
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selectedOSIds.size === selectedClient.os_list.length}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedClient.os_list.map((os) => (
                  <TableRow key={os.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedOSIds.has(os.id)}
                        onCheckedChange={() => toggleOS(os.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{os.codigo}</TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm">{os.descricao || "—"}</TableCell>
                    <TableCell className="text-sm">{os.data}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(os.valor_total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </div>
      )}

      {/* Negotiate Dialog */}
      <Dialog open={showNegotiate} onOpenChange={setShowNegotiate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Configurar Negociação</DialogTitle>
            <DialogDescription>
              {selectedOSIds.size} OS · Total: {formatCurrency(selectedTotal)}
            </DialogDescription>
          </DialogHeader>

          {!results ? (
            <div className="space-y-4">
              {/* Valor Negociado + Residual */}
              <div className="space-y-2">
                <Label>Valor a Negociar</Label>
                <Input
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={selectedTotal}
                  value={valorNegociado}
                  onChange={(e) => {
                    const v = Math.min(Number(e.target.value), selectedTotal);
                    setValorNegociado(Math.round(v * 100) / 100);
                  }}
                />
                {valorResidual > 0.01 && (
                  <div className="flex items-center justify-between rounded-md bg-accent/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Valor residual (próxima negociação):</span>
                    <span className="font-semibold text-accent-foreground">{formatCurrency(valorResidual)}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Nº Parcelas</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={parcelas}
                    onChange={(e) => setParcelas(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Dia Vencimento</Label>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={diaVencimento}
                    onChange={(e) => setDiaVencimento(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Mês de Início</Label>
                <Input
                  type="month"
                  value={mesInicio}
                  onChange={(e) => setMesInicio(e.target.value)}
                />
              </div>

              {/* Editable parcelas */}
              <div className="space-y-2">
                <Label>Valores das Parcelas</Label>
                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                  {valoresParcelas.map((val, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-16 shrink-0">
                        {previewDates[i] || `Parcela ${i + 1}`}
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        value={val}
                        onChange={(e) => handleParcelaValueChange(i, Number(e.target.value))}
                        className="h-8 text-sm"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                  <span>Total parcelas:</span>
                  <span className={`font-semibold ${Math.abs(valoresParcelas.reduce((a, b) => a + b, 0) - valorNegociado) > 0.02 ? 'text-destructive' : 'text-primary'}`}>
                    {formatCurrency(valoresParcelas.reduce((a, b) => a + b, 0))}
                  </span>
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowNegotiate(false)}>Cancelar</Button>
                <Button onClick={handleExecute} disabled={executing}>
                  {executing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Executar Negociação
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="max-h-60 overflow-y-auto space-y-1">
                {results.map((r) => (
                  <div key={r.os_id} className="flex items-center gap-2 text-sm">
                    {r.status === "ok" ? (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className="font-mono">{r.os_id}</span>
                    {r.error && <span className="text-destructive text-xs truncate">{r.error}</span>}
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button onClick={handleCloseResults}>Fechar</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Config Dialog */}
      <Dialog open={showConfig} onOpenChange={setShowConfig}>
        <DialogContent className="max-w-lg max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Configurar Situações</DialogTitle>
            <DialogDescription>
              Selecione quais situações de OS serão analisadas para negociação.
            </DialogDescription>
          </DialogHeader>

          {loadingSituacoes ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Carregando situações do GestãoClick...</span>
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto space-y-1 pr-1">
              {situacoes.map((sit) => (
                <label
                  key={sit.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedSituacoes.includes(sit.id)}
                    onCheckedChange={() => toggleSituacao(sit.id)}
                  />
                  <span className="text-sm flex-1">{sit.nome}</span>
                  <span className="text-xs text-muted-foreground font-mono">{sit.id}</span>
                </label>
              ))}
              {situacoes.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Nenhuma situação encontrada.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfig(false)}>Cancelar</Button>
            <Button onClick={handleSaveConfig} disabled={savingConfig || selectedSituacoes.length === 0}>
              {savingConfig ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar ({selectedSituacoes.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
