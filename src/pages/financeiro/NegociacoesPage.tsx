import { useState, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Loader2, Search, HandshakeIcon, ArrowLeft, Eye, RefreshCw, ChevronDown, ChevronRight, Trash2, Pencil } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import toast from "react-hot-toast";

interface GrupoReceber {
  id: string;
  nome: string;
  nome_cliente: string | null;
  cliente_gc_id: string | null;
  valor_total: number | null;
  data_vencimento: string | null;
  status: string | null;
  negociacao_numero: number | null;
  observacao: string | null;
  created_at: string | null;
  itens_total: number | null;
  itens_baixados: number | null;
  gc_baixado: boolean | null;
  inter_pago_em: string | null;
  valor_recebido: number | null;
}

interface Negociacao {
  numero: number;
  cliente: string;
  cliente_gc_id: string | null;
  parcelas: GrupoReceber[];
  valor_total: number;
  total_parcelas: number;
  parcelas_pagas: number;
  status: "aberto" | "pago_parcial" | "pago";
  created_at: string;
}

export default function NegociacoesPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [grupos, setGrupos] = useState<GrupoReceber[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [expandedNeg, setExpandedNeg] = useState<Set<number>>(new Set());
  const [selectedNeg, setSelectedNeg] = useState<Negociacao | null>(null);

  const fetchGrupos = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("fin_grupos_receber")
        .select("*")
        .not("negociacao_numero", "is", null)
        .order("negociacao_numero", { ascending: false });

      if (error) throw error;
      setGrupos((data as GrupoReceber[]) || []);
    } catch (err) {
      toast.error(`Erro: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGrupos();
  }, []);

  const negociacoes = useMemo(() => {
    const map = new Map<number, Negociacao>();

    for (const g of grupos) {
      const num = g.negociacao_numero!;
      if (!map.has(num)) {
        map.set(num, {
          numero: num,
          cliente: g.nome_cliente || "—",
          cliente_gc_id: g.cliente_gc_id,
          parcelas: [],
          valor_total: 0,
          total_parcelas: 0,
          parcelas_pagas: 0,
          status: "aberto",
          created_at: g.created_at || "",
        });
      }
      const neg = map.get(num)!;
      neg.parcelas.push(g);
      neg.valor_total += g.valor_total || 0;
      neg.total_parcelas++;
      if (g.status === "pago" || g.gc_baixado) {
        neg.parcelas_pagas++;
      }
    }

    for (const neg of map.values()) {
      neg.parcelas.sort((a, b) => (a.data_vencimento || "").localeCompare(b.data_vencimento || ""));
      if (neg.parcelas_pagas >= neg.total_parcelas) {
        neg.status = "pago";
      } else if (neg.parcelas_pagas > 0) {
        neg.status = "pago_parcial";
      }
    }

    return Array.from(map.values());
  }, [grupos]);

  const filtered = useMemo(() => {
    if (!searchTerm) return negociacoes;
    const term = searchTerm.toLowerCase();
    return negociacoes.filter(
      (n) =>
        n.cliente.toLowerCase().includes(term) ||
        String(n.numero).includes(term)
    );
  }, [negociacoes, searchTerm]);

  const toggleExpand = (num: number) => {
    setExpandedNeg((prev) => {
      const next = new Set(prev);
      if (next.has(num)) next.delete(num);
      else next.add(num);
      return next;
    });
  };

  const formatCurrency = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  const formatDate = (d: string | null) => {
    if (!d) return "—";
    try {
      return new Date(d + "T00:00:00").toLocaleDateString("pt-BR");
    } catch {
      return d;
    }
  };

  const statusBadge = (status: string | null) => {
    switch (status) {
      case "pago":
        return <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30">Pago</Badge>;
      case "pago_parcial":
        return <Badge className="bg-amber-500/20 text-amber-400 border-amber-500/30">Parcial</Badge>;
      default:
        return <Badge variant="outline">Aberto</Badge>;
    }
  };

  const handleReprocess = async (neg: Negociacao) => {
    toast("Reprocessamento será implementado em breve", { icon: "🔄" });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <HandshakeIcon className="h-6 w-6" />
              Negociações
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              {negociacoes.length} negociação(ões) registrada(s)
            </p>
          </div>
        </div>
        <Button onClick={fetchGrupos} disabled={loading} variant="outline" size="sm">
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Atualizar
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Total Negociações</p>
            <p className="text-2xl font-bold">{negociacoes.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Valor Total</p>
            <p className="text-2xl font-bold text-primary">
              {formatCurrency(negociacoes.reduce((s, n) => s + n.valor_total, 0))}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Em Aberto</p>
            <p className="text-2xl font-bold text-amber-400">
              {negociacoes.filter((n) => n.status !== "pago").length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-sm text-muted-foreground">Concluídas</p>
            <p className="text-2xl font-bold text-emerald-400">
              {negociacoes.filter((n) => n.status === "pago").length}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por cliente ou nº negociação..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Nº Neg.</TableHead>
                <TableHead>Cliente</TableHead>
                <TableHead>Parcelas</TableHead>
                <TableHead>Progresso</TableHead>
                <TableHead className="text-right">Valor Total</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Data</TableHead>
                <TableHead className="w-20">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="text-center text-muted-foreground py-10">
                    Nenhuma negociação encontrada.
                  </TableCell>
                </TableRow>
              )}
              {filtered.map((neg) => (
                <>
                  <TableRow
                    key={neg.numero}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => toggleExpand(neg.numero)}
                  >
                    <TableCell>
                      {expandedNeg.has(neg.numero) ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="font-mono font-bold text-primary">
                      #{neg.numero}
                    </TableCell>
                    <TableCell className="font-medium max-w-[200px] truncate">
                      {neg.cliente}
                    </TableCell>
                    <TableCell>{neg.total_parcelas}x</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-20 h-2 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full bg-primary transition-all"
                            style={{ width: `${(neg.parcelas_pagas / neg.total_parcelas) * 100}%` }}
                          />
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {neg.parcelas_pagas}/{neg.total_parcelas}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="text-right font-semibold">
                      {formatCurrency(neg.valor_total)}
                    </TableCell>
                    <TableCell>{statusBadge(neg.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {neg.created_at ? new Date(neg.created_at).toLocaleDateString("pt-BR") : "—"}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedNeg(neg);
                        }}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>

                  {/* Expanded parcelas */}
                  {expandedNeg.has(neg.numero) &&
                    neg.parcelas.map((p, idx) => (
                      <TableRow key={p.id} className="bg-muted/30">
                        <TableCell />
                        <TableCell className="text-xs text-muted-foreground pl-8">
                          Parcela {idx + 1}
                        </TableCell>
                        <TableCell className="text-sm truncate max-w-[200px]">
                          {p.nome}
                        </TableCell>
                        <TableCell />
                        <TableCell>
                          {p.gc_baixado ? (
                            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                              Baixado GC
                            </Badge>
                          ) : p.inter_pago_em ? (
                            <Badge className="bg-blue-500/20 text-blue-400 border-blue-500/30 text-xs">
                              Pago Inter
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">Pendente</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {formatCurrency(p.valor_total || 0)}
                        </TableCell>
                        <TableCell>{statusBadge(p.status)}</TableCell>
                        <TableCell className="text-sm">
                          {formatDate(p.data_vencimento)}
                        </TableCell>
                        <TableCell />
                      </TableRow>
                    ))}
                </>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* Detail Dialog */}
      <Dialog open={!!selectedNeg} onOpenChange={() => setSelectedNeg(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <HandshakeIcon className="h-5 w-5" />
              Negociação #{selectedNeg?.numero}
            </DialogTitle>
            <DialogDescription>
              {selectedNeg?.cliente} · {selectedNeg?.total_parcelas} parcelas · {formatCurrency(selectedNeg?.valor_total || 0)}
            </DialogDescription>
          </DialogHeader>

          {selectedNeg && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground">Status</p>
                  <div className="mt-1">{statusBadge(selectedNeg.status)}</div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Progresso</p>
                  <p className="font-semibold mt-1">
                    {selectedNeg.parcelas_pagas}/{selectedNeg.total_parcelas} pagas
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Criada em</p>
                  <p className="text-sm mt-1">
                    {selectedNeg.created_at ? new Date(selectedNeg.created_at).toLocaleDateString("pt-BR") : "—"}
                  </p>
                </div>
              </div>

              <div className="rounded-lg border overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>#</TableHead>
                      <TableHead>Vencimento</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>GC</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {selectedNeg.parcelas.map((p, idx) => (
                      <TableRow key={p.id}>
                        <TableCell className="font-mono text-sm">{idx + 1}</TableCell>
                        <TableCell>{formatDate(p.data_vencimento)}</TableCell>
                        <TableCell className="text-right font-semibold">
                          {formatCurrency(p.valor_total || 0)}
                        </TableCell>
                        <TableCell>{statusBadge(p.status)}</TableCell>
                        <TableCell>
                          {p.gc_baixado ? (
                            <Badge className="bg-emerald-500/20 text-emerald-400 border-emerald-500/30 text-xs">
                              ✓ Baixado
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-xs">Pendente</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              {selectedNeg.parcelas[0]?.observacao && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-xs text-muted-foreground mb-1">Observações</p>
                  <p className="text-sm whitespace-pre-line">{selectedNeg.parcelas[0].observacao}</p>
                </div>
              )}

              <DialogFooter>
                <Button variant="outline" onClick={() => setSelectedNeg(null)}>
                  Fechar
                </Button>
                <Button variant="outline" onClick={() => handleReprocess(selectedNeg)}>
                  <RefreshCw className="h-4 w-4 mr-2" />
                  Reprocessar
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
