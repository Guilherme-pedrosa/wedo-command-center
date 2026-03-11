import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, HandshakeIcon, AlertCircle, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import toast from "react-hot-toast";

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

export default function NegociacaoOSPage() {
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [clients, setClients] = useState<ClientGroup[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientGroup | null>(null);
  const [selectedOSIds, setSelectedOSIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");

  // Negotiation params
  const [showNegotiate, setShowNegotiate] = useState(false);
  const [parcelas, setParcelas] = useState(10);
  const [diaVencimento, setDiaVencimento] = useState(10);
  const [mesInicio, setMesInicio] = useState(() => {
    const d = new Date();
    d.setMonth(d.getMonth() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });

  // Results
  const [results, setResults] = useState<NegotiateResult[] | null>(null);

  const fetchOS = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("negotiate-os", {
        body: { action: "list" },
      });
      if (error) throw error;
      setClients(data.clients || []);
      if (data.clients?.length === 0) {
        toast("Nenhuma OS em 'Ag Negociação' encontrada", { icon: "ℹ️" });
      }
    } catch (err) {
      toast.error(`Erro ao buscar OS: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchOS();
  }, []);

  const filteredClients = clients.filter((c) =>
    c.nome_cliente.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelectClient = (client: ClientGroup) => {
    setSelectedClient(client);
    setSelectedOSIds(new Set(client.os_list.map((os) => os.id)));
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

  const valorParcela = parcelas > 0 ? selectedTotal / parcelas : 0;

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
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <HandshakeIcon className="h-6 w-6" />
            Negociação de OS
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            OS em "Executado - Ag Negociação" agrupadas por cliente
          </p>
        </div>
        <Button onClick={fetchOS} disabled={loading} variant="outline" size="sm">
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
          Atualizar
        </Button>
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
              <Button variant="ghost" size="sm" onClick={() => { setSelectedClient(null); setSelectedOSIds(new Set()); }}>
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

              <Card className="bg-muted/50">
                <CardContent className="pt-4 space-y-2">
                  <p className="text-sm font-medium">Resumo</p>
                  <div className="grid grid-cols-2 gap-2 text-sm">
                    <span className="text-muted-foreground">Valor por parcela:</span>
                    <span className="font-semibold text-right">{formatCurrency(valorParcela)}</span>
                    <span className="text-muted-foreground">Primeira parcela:</span>
                    <span className="text-right">{previewDates[0] || "—"}</span>
                    <span className="text-muted-foreground">Última parcela:</span>
                    <span className="text-right">{previewDates[previewDates.length - 1] || "—"}</span>
                  </div>
                </CardContent>
              </Card>

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
    </div>
  );
}
