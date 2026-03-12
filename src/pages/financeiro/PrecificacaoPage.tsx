import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchAllGCPages } from "@/lib/gc-client";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, Search, Calculator, Package, TrendingUp, AlertTriangle, DollarSign, BarChart3, RefreshCw, FileText, Info, ShoppingCart, Wrench } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import toast from "react-hot-toast";

// ── Types ──
interface GCProduto {
  id: string;
  nome: string;
  codigo?: string;
  codigo_interno?: string;
  estoque: number | string;
  valor_custo: string;
  valor_venda: string;
  nome_grupo?: string;
  ncm?: string;
  unidade?: string;
}

interface ProdutoTributo {
  gc_produto_id: string;
  nome_produto: string;
  ncm: string | null;
  nf_numero: string | null;
  nf_data_emissao: string | null;
  fornecedor_nome: string | null;
  icms_aliquota: number;
  pis_aliquota: number;
  cofins_aliquota: number;
  ipi_aliquota: number;
  frete_percentual: number;
  valor_unitario_nf: number;
  valor_icms_unit: number;
  valor_pis_unit: number;
  valor_cofins_unit: number;
  valor_ipi_unit: number;
  valor_frete_unit: number;
  custo_efetivo_unit: number;
}

type TipoSaida = "venda" | "servico";

interface TaxConfigEntrada {
  icmsCredito: number;   // Crédito ICMS entrada (%)
  pisCredito: number;    // Crédito PIS entrada (%)
  cofinsCredito: number; // Crédito COFINS entrada (%)
  frete: number;         // Frete (% custo)
  custoFixoUnit: number; // Custo fixo por unidade (R$)
}

interface TaxConfigSaida {
  // Venda de produto
  icmsSaida: number;     // ICMS saída (%)
  pisSaida: number;      // PIS saída (%)
  cofinsSaida: number;   // COFINS saída (%)
  // Serviço
  iss: number;           // ISS (%)
  pisSaidaServico: number;
  cofinsSaidaServico: number;
  // Comum
  irpjCsll: number;     // IRPJ+CSLL sobre lucro (%)
}

const DEFAULT_ENTRADA: TaxConfigEntrada = {
  icmsCredito: 18,
  pisCredito: 1.65,
  cofinsCredito: 7.6,
  frete: 5,
  custoFixoUnit: 0,
};

const DEFAULT_SAIDA: TaxConfigSaida = {
  icmsSaida: 18,
  pisSaida: 1.65,
  cofinsSaida: 7.6,
  iss: 3,
  pisSaidaServico: 1.65,
  cofinsSaidaServico: 7.6,
  irpjCsll: 24,
};

// ── Helpers ──
function calcPricing(
  custoBruto: number,
  entrada: TaxConfigEntrada,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  margemDesejada: number
) {
  // Créditos de entrada
  const creditoIcms = custoBruto * (entrada.icmsCredito / 100);
  const creditoPis = custoBruto * (entrada.pisCredito / 100);
  const creditoCofins = custoBruto * (entrada.cofinsCredito / 100);
  const totalCreditosEntrada = creditoIcms + creditoPis + creditoCofins;

  const custoLiquido = custoBruto - totalCreditosEntrada;
  const custoFrete = custoBruto * (entrada.frete / 100);
  const custoTotal = custoLiquido + custoFrete + entrada.custoFixoUnit;

  // Alíquotas de saída (incidem sobre faturamento)
  let aliquotaSaidaFaturamento: number;
  if (tipo === "venda") {
    aliquotaSaidaFaturamento = (saida.icmsSaida + saida.pisSaida + saida.cofinsSaida) / 100;
  } else {
    aliquotaSaidaFaturamento = (saida.iss + saida.pisSaidaServico + saida.cofinsSaidaServico) / 100;
  }

  // IRPJ/CSLL incide sobre lucro, não faturamento — simplificamos como % do faturamento
  // Na prática Lucro Real: IRPJ 15% + adicional 10% + CSLL 9% sobre lucro líquido
  // Para markup inverso, tratamos como % do faturamento para simplificar
  const irpjPct = saida.irpjCsll / 100;

  const margemDecimal = margemDesejada / 100;
  // Preço = CustoTotal / (1 - tributos_saida - margem)
  const divisor = 1 - aliquotaSaidaFaturamento - margemDecimal;
  const precoMinimo = divisor > 0 ? custoTotal / divisor : custoTotal * 3;

  const tributosSaida = precoMinimo * aliquotaSaidaFaturamento;
  const lucroAnteIR = precoMinimo - custoTotal - tributosSaida;
  const impostoRenda = Math.max(0, lucroAnteIR * irpjPct);
  const lucroLiquido = lucroAnteIR - impostoRenda;

  return {
    creditoIcms,
    creditoPis,
    creditoCofins,
    totalCreditosEntrada,
    custoLiquido,
    custoFrete,
    custoTotal,
    precoMinimo,
    tributosSaida,
    impostoRenda,
    lucroAnteIR,
    lucroLiquido,
    margemReal: precoMinimo > 0 ? (lucroLiquido / precoMinimo) * 100 : 0,
    aliquotaSaidaFaturamento,
  };
}

function calcPricingWithNF(
  tributo: ProdutoTributo,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  custoFixo: number,
  margemDesejada: number
) {
  // custo_efetivo_unit already has entry credits applied
  const custoTotal = tributo.custo_efetivo_unit + custoFixo;

  let aliquotaSaidaFaturamento: number;
  if (tipo === "venda") {
    aliquotaSaidaFaturamento = (saida.icmsSaida + saida.pisSaida + saida.cofinsSaida) / 100;
  } else {
    aliquotaSaidaFaturamento = (saida.iss + saida.pisSaidaServico + saida.cofinsSaidaServico) / 100;
  }

  const irpjPct = saida.irpjCsll / 100;
  const margemDecimal = margemDesejada / 100;
  const divisor = 1 - aliquotaSaidaFaturamento - margemDecimal;
  const precoMinimo = divisor > 0 ? custoTotal / divisor : custoTotal * 3;

  const tributosSaida = precoMinimo * aliquotaSaidaFaturamento;
  const lucroAnteIR = precoMinimo - custoTotal - tributosSaida;
  const impostoRenda = Math.max(0, lucroAnteIR * irpjPct);
  const lucroLiquido = lucroAnteIR - impostoRenda;

  return {
    custoTotal,
    precoMinimo,
    tributosSaida,
    impostoRenda,
    lucroAnteIR,
    lucroLiquido,
    aliquotaSaidaFaturamento,
  };
}

export default function PrecificacaoPage() {
  const [search, setSearch] = useState("");
  const [taxEntrada, setTaxEntrada] = useState<TaxConfigEntrada>(DEFAULT_ENTRADA);
  const [taxSaida, setTaxSaida] = useState<TaxConfigSaida>(DEFAULT_SAIDA);
  const [tipoSaidaGlobal, setTipoSaidaGlobal] = useState<TipoSaida>("venda");
  const [margemAlvo, setMargemAlvo] = useState(15);
  const [syncing, setSyncing] = useState(false);
  const [calcCusto, setCalcCusto] = useState<string>("");
  const [calcTipoSaida, setCalcTipoSaida] = useState<TipoSaida>("venda");
  const [calcMargens] = useState([10, 15, 20, 25, 30]);

  // ── Fetch products from GC ──
  const { data: produtos, isLoading: loadingProdutos } = useQuery({
    queryKey: ["gc-produtos"],
    queryFn: () => fetchAllGCPages<GCProduto>("/api/produtos"),
    staleTime: 5 * 60_000,
  });

  // ── Fetch product tax profiles from NFs ──
  const { data: tributos, refetch: refetchTributos } = useQuery({
    queryKey: ["produto-tributos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_produto_tributos")
        .select("*")
        .order("nome_produto");
      return (data || []) as ProdutoTributo[];
    },
    staleTime: 5 * 60_000,
  });

  const tributosMap = useMemo(() => {
    const map = new Map<string, ProdutoTributo>();
    tributos?.forEach((t) => map.set(t.gc_produto_id, t));
    return map;
  }, [tributos]);

  // ── Fetch monthly fixed costs for auto-rateio ──
  const { data: custoFixoMensal } = useQuery({
    queryKey: ["custo-fixo-mensal"],
    queryFn: async () => {
      const now = new Date();
      const mesAtual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("valor")
        .like("data_competencia", `${mesAtual}%`)
        .not("plano_contas_id", "is", null);
      return data?.reduce((sum, r) => sum + Math.abs(Number(r.valor) || 0), 0) || 0;
    },
    staleTime: 10 * 60_000,
  });

  // ── Filtered products ──
  const filtered = useMemo(() => {
    if (!produtos) return [];
    const q = search.toLowerCase();
    return produtos
      .filter((p) => {
        const nome = (p.nome || "").toLowerCase();
        const codigo = (p.codigo || p.codigo_interno || "").toLowerCase();
        return nome.includes(q) || codigo.includes(q);
      })
      .slice(0, 100);
  }, [produtos, search]);

  const totalProdutosEstoque = useMemo(() => {
    if (!produtos) return 1;
    return produtos.reduce((sum, p) => sum + (Number(p.estoque) || 0), 0) || 1;
  }, [produtos]);

  const custoFixoAutoUnit = custoFixoMensal ? custoFixoMensal / totalProdutosEstoque : 0;
  const activeEntrada = { ...taxEntrada, custoFixoUnit: taxEntrada.custoFixoUnit || custoFixoAutoUnit };

  // ── Sync NFs de entrada ──
  const handleSyncNFEntrada = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-nfe-entrada");
      if (error) throw error;
      toast.success(`Sincronizado: ${data.produtos_processados} produtos de ${data.total_nfs} NFs`);
      refetchTributos();
    } catch (err: unknown) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSyncing(false);
    }
  };

  // ── Calculator results ──
  const calcResults = useMemo(() => {
    const custo = parseFloat(calcCusto) || 0;
    if (custo <= 0) return [];
    return calcMargens.map((m) => ({
      margem: m,
      ...calcPricing(custo, activeEntrada, taxSaida, calcTipoSaida, m),
    }));
  }, [calcCusto, calcMargens, activeEntrada, taxSaida, calcTipoSaida]);

  const totalComTributoNF = tributos?.length || 0;

  // Helper to get exit tax label
  const getTipoSaidaLabel = (tipo: TipoSaida) =>
    tipo === "venda" ? "Venda Produto" : "Prestação Serviço";

  const getTipoSaidaAliquota = (tipo: TipoSaida) => {
    if (tipo === "venda") {
      return `ICMS ${taxSaida.icmsSaida}% + PIS ${taxSaida.pisSaida}% + COFINS ${taxSaida.cofinsSaida}%`;
    }
    return `ISS ${taxSaida.iss}% + PIS ${taxSaida.pisSaidaServico}% + COFINS ${taxSaida.cofinsSaidaServico}%`;
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Calculator className="h-6 w-6 text-primary" />
            Precificação de Produtos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tributação de entrada (NF) + saída (Venda/Serviço) — Lucro Real
          </p>
        </div>
        <div className="flex items-center gap-3">
          {custoFixoMensal !== undefined && (
            <Badge variant="outline" className="text-xs">
              Custo fixo: {formatCurrency(custoFixoMensal)} · /un: {formatCurrency(custoFixoAutoUnit)}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs">
            <FileText className="h-3 w-3 mr-1" />
            {totalComTributoNF} produtos c/ tributo NF
          </Badge>
          <Button variant="outline" size="sm" onClick={handleSyncNFEntrada} disabled={syncing}>
            {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Sync NFs Entrada
          </Button>
        </div>
      </div>

      {/* ── Tax Config: Entrada + Saída side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ENTRADA */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Package className="h-4 w-4" />
              Tributos de Entrada (Créditos)
              <Tooltip>
                <TooltipTrigger><Info className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Créditos fiscais na compra (Lucro Real). Quando o produto tem NF de entrada, os valores reais da NF são priorizados.
                </TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Créd. ICMS (%)</Label>
                <Input type="number" value={taxEntrada.icmsCredito}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, icmsCredito: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Créd. PIS (%)</Label>
                <Input type="number" value={taxEntrada.pisCredito}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, pisCredito: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Créd. COFINS (%)</Label>
                <Input type="number" value={taxEntrada.cofinsCredito}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, cofinsCredito: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Frete (% custo)</Label>
                <Input type="number" value={taxEntrada.frete}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, frete: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Custo fixo/un (R$)</Label>
                <Input type="number" placeholder={custoFixoAutoUnit.toFixed(2)}
                  value={taxEntrada.custoFixoUnit || ""}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, custoFixoUnit: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
                <p className="text-[10px] text-muted-foreground">Vazio = rateio auto</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* SAÍDA */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Tributos de Saída (Faturamento)
              <Tooltip>
                <TooltipTrigger><Info className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Tributos que incidem na venda. Muda conforme o produto sai como <strong>Venda</strong> (ICMS) ou <strong>Serviço</strong> (ISS).
                  IRPJ+CSLL incide sobre o lucro.
                </TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {/* Venda */}
              <div className="space-y-2 p-3 rounded-lg bg-secondary/50 border border-border">
                <div className="flex items-center gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs font-semibold text-blue-400 uppercase">Venda Produto</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">ICMS %</Label>
                    <Input type="number" value={taxSaida.icmsSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, icmsSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">PIS %</Label>
                    <Input type="number" value={taxSaida.pisSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, pisSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">COFINS %</Label>
                    <Input type="number" value={taxSaida.cofinsSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, cofinsSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Total: {(taxSaida.icmsSaida + taxSaida.pisSaida + taxSaida.cofinsSaida).toFixed(2)}% s/ faturamento
                </p>
              </div>

              {/* Serviço */}
              <div className="space-y-2 p-3 rounded-lg bg-secondary/50 border border-border">
                <div className="flex items-center gap-1.5">
                  <Wrench className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400 uppercase">Serviço</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">ISS %</Label>
                    <Input type="number" value={taxSaida.iss}
                      onChange={(e) => setTaxSaida({ ...taxSaida, iss: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">PIS %</Label>
                    <Input type="number" value={taxSaida.pisSaidaServico}
                      onChange={(e) => setTaxSaida({ ...taxSaida, pisSaidaServico: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">COFINS %</Label>
                    <Input type="number" value={taxSaida.cofinsSaidaServico}
                      onChange={(e) => setTaxSaida({ ...taxSaida, cofinsSaidaServico: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Total: {(taxSaida.iss + taxSaida.pisSaidaServico + taxSaida.cofinsSaidaServico).toFixed(2)}% s/ faturamento
                </p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              <div className="space-y-1 flex-1">
                <Label className="text-xs text-muted-foreground">IRPJ+CSLL s/ lucro (%)</Label>
                <Input type="number" value={taxSaida.irpjCsll}
                  onChange={(e) => setTaxSaida({ ...taxSaida, irpjCsll: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
              </div>
              <p className="text-[10px] text-muted-foreground mt-4 flex-1">
                IRPJ 15% + Adicional 10% (lucro &gt; 20k/mês) + CSLL 9% = ~24% sobre lucro líquido antes IR
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="estoque" className="space-y-4">
        <TabsList className="bg-secondary">
          <TabsTrigger value="estoque" className="gap-1.5">
            <Package className="h-4 w-4" /> Análise Estoque
          </TabsTrigger>
          <TabsTrigger value="calculadora" className="gap-1.5">
            <Calculator className="h-4 w-4" /> Calculadora Margem
          </TabsTrigger>
          <TabsTrigger value="tributos" className="gap-1.5">
            <FileText className="h-4 w-4" /> Tributos NF Entrada
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: Análise Estoque ── */}
        <TabsContent value="estoque" className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-md">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input placeholder="Buscar produto por nome ou código..." value={search}
                onChange={(e) => setSearch(e.target.value)} className="pl-9 bg-secondary" />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Tipo saída:</Label>
              <Select value={tipoSaidaGlobal} onValueChange={(v) => setTipoSaidaGlobal(v as TipoSaida)}>
                <SelectTrigger className="w-[160px] h-8 text-xs bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="venda">
                    <span className="flex items-center gap-1.5"><ShoppingCart className="h-3 w-3" /> Venda Produto</span>
                  </SelectItem>
                  <SelectItem value="servico">
                    <span className="flex items-center gap-1.5"><Wrench className="h-3 w-3" /> Serviço</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Margem alvo:</Label>
              <div className="w-32">
                <Slider value={[margemAlvo]} onValueChange={([v]) => setMargemAlvo(v)} min={5} max={50} step={1} />
              </div>
              <Badge variant="secondary" className="text-xs font-mono w-12 justify-center">{margemAlvo}%</Badge>
            </div>
            {loadingProdutos && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            Saída como <strong className={tipoSaidaGlobal === "venda" ? "text-blue-400" : "text-amber-400"}>
              {getTipoSaidaLabel(tipoSaidaGlobal)}
            </strong>: {getTipoSaidaAliquota(tipoSaidaGlobal)} + IRPJ/CSLL {taxSaida.irpjCsll}% s/ lucro
          </div>

          <Card className="border-border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-xs">Produto</TableHead>
                  <TableHead className="text-xs text-right">Estoque</TableHead>
                  <TableHead className="text-xs text-right">Custo</TableHead>
                  <TableHead className="text-xs text-center">Fonte</TableHead>
                  <TableHead className="text-xs text-right">Créd. Entrada</TableHead>
                  <TableHead className="text-xs text-right">Custo Total</TableHead>
                  <TableHead className="text-xs text-right">Trib. Saída</TableHead>
                  <TableHead className="text-xs text-right">IR s/ Lucro</TableHead>
                  <TableHead className="text-xs text-right font-semibold text-primary">Preço Mín.</TableHead>
                  <TableHead className="text-xs text-right">Venda GC</TableHead>
                  <TableHead className="text-xs text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && !loadingProdutos && (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      {search ? "Nenhum produto encontrado" : "Busque produtos do estoque GestãoClick"}
                    </TableCell>
                  </TableRow>
                )}
                {filtered.map((p) => {
                  const custoBruto = parseFloat(p.valor_custo) || 0;
                  const vendaGC = parseFloat(p.valor_venda) || 0;
                  const estoque = Number(p.estoque) || 0;
                  const tributo = tributosMap.get(p.id);
                  const hasNF = !!tributo;

                  let calc: ReturnType<typeof calcPricing>;
                  if (hasNF) {
                    const nfCalc = calcPricingWithNF(tributo, taxSaida, tipoSaidaGlobal, activeEntrada.custoFixoUnit, margemAlvo);
                    calc = {
                      creditoIcms: tributo.valor_icms_unit,
                      creditoPis: tributo.valor_pis_unit,
                      creditoCofins: tributo.valor_cofins_unit,
                      totalCreditosEntrada: tributo.valor_icms_unit + tributo.valor_pis_unit + tributo.valor_cofins_unit,
                      custoLiquido: tributo.custo_efetivo_unit,
                      custoFrete: tributo.valor_frete_unit,
                      custoTotal: nfCalc.custoTotal,
                      precoMinimo: nfCalc.precoMinimo,
                      tributosSaida: nfCalc.tributosSaida,
                      impostoRenda: nfCalc.impostoRenda,
                      lucroAnteIR: nfCalc.lucroAnteIR,
                      lucroLiquido: nfCalc.lucroLiquido,
                      margemReal: nfCalc.precoMinimo > 0 ? (nfCalc.lucroLiquido / nfCalc.precoMinimo) * 100 : 0,
                      aliquotaSaidaFaturamento: nfCalc.aliquotaSaidaFaturamento,
                    };
                  } else {
                    calc = calcPricing(custoBruto, activeEntrada, taxSaida, tipoSaidaGlobal, margemAlvo);
                  }

                  const abaixoMinimo = vendaGC > 0 && vendaGC < calc.precoMinimo;
                  // Estimate current margin at GC sale price
                  const margemAtualVendaGC = vendaGC > 0 && calc.custoTotal > 0
                    ? (() => {
                        const tribSaida = vendaGC * calc.aliquotaSaidaFaturamento;
                        const lucroAI = vendaGC - calc.custoTotal - tribSaida;
                        const ir = Math.max(0, lucroAI * (taxSaida.irpjCsll / 100));
                        return ((lucroAI - ir) / vendaGC) * 100;
                      })()
                    : 0;

                  return (
                    <TableRow key={p.id} className="border-border">
                      <TableCell>
                        <div>
                          <span className="font-medium text-foreground text-sm">{p.nome}</span>
                          {(p.codigo || p.codigo_interno) && (
                            <span className="text-xs text-muted-foreground ml-2">#{p.codigo || p.codigo_interno}</span>
                          )}
                          {p.nome_grupo && (
                            <Badge variant="outline" className="ml-2 text-[10px] py-0">{p.nome_grupo}</Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{estoque}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(hasNF ? tributo.valor_unitario_nf : custoBruto)}</TableCell>
                      <TableCell className="text-center">
                        {hasNF ? (
                          <Tooltip>
                            <TooltipTrigger>
                              <Badge className="bg-primary/20 text-primary text-[10px] gap-1">
                                <FileText className="h-3 w-3" /> NF
                              </Badge>
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-sm">
                              <p className="font-semibold">NF #{tributo.nf_numero} — {tributo.fornecedor_nome}</p>
                              <p>ICMS: {tributo.icms_aliquota}% · PIS: {tributo.pis_aliquota}% · COFINS: {tributo.cofins_aliquota}%</p>
                              <p>IPI: {tributo.ipi_aliquota}% · Frete: {tributo.frete_percentual}%</p>
                              <p>Custo efetivo: {formatCurrency(tributo.custo_efetivo_unit)}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">Manual</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-green-400">
                        -{formatCurrency(calc.totalCreditosEntrada)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(calc.custoTotal)}</TableCell>
                      <TableCell className="text-right font-mono text-sm text-orange-400">
                        {formatCurrency(calc.tributosSaida)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-red-400">
                        {formatCurrency(calc.impostoRenda)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-bold text-primary">
                        {formatCurrency(calc.precoMinimo)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(vendaGC)}</TableCell>
                      <TableCell className="text-center">
                        {custoBruto === 0 && !hasNF ? (
                          <Badge variant="outline" className="text-[10px] text-muted-foreground">Sem custo</Badge>
                        ) : abaixoMinimo ? (
                          <Badge className="bg-destructive/20 text-destructive text-[10px] gap-1">
                            <AlertTriangle className="h-3 w-3" /> {margemAtualVendaGC.toFixed(1)}%
                          </Badge>
                        ) : (
                          <Badge className="bg-green-500/20 text-green-400 text-[10px] gap-1">
                            <TrendingUp className="h-3 w-3" /> {margemAtualVendaGC.toFixed(1)}%
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          {produtos && (
            <p className="text-xs text-muted-foreground">
              {produtos.length} produtos · {totalComTributoNF} com tributo NF · Mostrando {filtered.length} · Tipo saída: {getTipoSaidaLabel(tipoSaidaGlobal)}
            </p>
          )}
        </TabsContent>

        {/* ── TAB: Calculadora ── */}
        <TabsContent value="calculadora" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-primary" />
                  Valor do Equipamento
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Custo de aquisição (R$)</Label>
                  <Input type="number" placeholder="Ex: 5000.00" value={calcCusto}
                    onChange={(e) => setCalcCusto(e.target.value)}
                    className="text-lg h-12 bg-secondary font-mono" />
                </div>

                <div className="space-y-2">
                  <Label>Como o produto vai sair?</Label>
                  <Select value={calcTipoSaida} onValueChange={(v) => setCalcTipoSaida(v as TipoSaida)}>
                    <SelectTrigger className="bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="venda">
                        <span className="flex items-center gap-1.5"><ShoppingCart className="h-3.5 w-3.5 text-blue-400" /> Venda de Produto (ICMS)</span>
                      </SelectItem>
                      <SelectItem value="servico">
                        <span className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5 text-amber-400" /> Prestação de Serviço (ISS)</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {calcCusto && parseFloat(calcCusto) > 0 && (
                  <div className="bg-secondary/50 rounded-lg p-4 space-y-2 text-sm">
                    <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Composição de custo</p>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Custo bruto</span>
                      <span className="font-mono">{formatCurrency(parseFloat(calcCusto))}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. ICMS ({activeEntrada.icmsCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.icmsCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. PIS ({activeEntrada.pisCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.pisCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. COFINS ({activeEntrada.cofinsCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.cofinsCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Frete ({activeEntrada.frete}%)</span>
                      <span className="font-mono">+{formatCurrency(parseFloat(calcCusto) * activeEntrada.frete / 100)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Custo fixo unit.</span>
                      <span className="font-mono">+{formatCurrency(activeEntrada.custoFixoUnit)}</span>
                    </div>
                    <div className="border-t border-border pt-2 flex justify-between font-semibold">
                      <span>Custo total</span>
                      <span className="font-mono">
                        {formatCurrency(
                          parseFloat(calcCusto) * (1 - (activeEntrada.icmsCredito + activeEntrada.pisCredito + activeEntrada.cofinsCredito) / 100 + activeEntrada.frete / 100) + activeEntrada.custoFixoUnit
                        )}
                      </span>
                    </div>
                    <div className="border-t border-border pt-2 mt-1">
                      <p className="text-[10px] text-muted-foreground">
                        Tributos de saída ({calcTipoSaida === "venda" ? "Venda" : "Serviço"}): {getTipoSaidaAliquota(calcTipoSaida)}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Cenários de Margem
                  <Badge variant="outline" className={`text-[10px] ${calcTipoSaida === "venda" ? "text-blue-400 border-blue-400/30" : "text-amber-400 border-amber-400/30"}`}>
                    {calcTipoSaida === "venda" ? "Venda" : "Serviço"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {calcResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Insira o valor do equipamento para ver os cenários
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-xs">Margem</TableHead>
                        <TableHead className="text-xs text-right">Preço Mín.</TableHead>
                        <TableHead className="text-xs text-right">Trib. Saída</TableHead>
                        <TableHead className="text-xs text-right">IR s/ Lucro</TableHead>
                        <TableHead className="text-xs text-right">Lucro Líq.</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calcResults.map((r) => (
                        <TableRow key={r.margem} className="border-border">
                          <TableCell>
                            <Badge
                              variant={r.margem === 15 ? "default" : "outline"}
                              className={r.margem === 15 ? "bg-primary text-primary-foreground" : ""}
                            >
                              {r.margem}%
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold text-primary">
                            {formatCurrency(r.precoMinimo)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-orange-400">
                            {formatCurrency(r.tributosSaida)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-red-400">
                            {formatCurrency(r.impostoRenda)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-green-400">
                            {formatCurrency(r.lucroLiquido)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border bg-card">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Fórmula (Markup Inverso — Lucro Real):</strong>{" "}
                Preço = Custo Total ÷ (1 − Tributos Saída − Margem).{" "}
                <strong>Venda:</strong> ICMS + PIS + COFINS sobre faturamento.{" "}
                <strong>Serviço:</strong> ISS + PIS + COFINS sobre faturamento.{" "}
                Em ambos, IRPJ+CSLL ({taxSaida.irpjCsll}%) incide sobre o lucro.
                Créditos de entrada (ICMS {activeEntrada.icmsCredito}% + PIS {activeEntrada.pisCredito}% + COFINS {activeEntrada.cofinsCredito}%) reduzem o custo de aquisição.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB: Tributos NF Entrada ── */}
        <TabsContent value="tributos" className="space-y-4">
          <Card className="border-border bg-card overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Tributos Extraídos das NFs de Entrada
                </span>
                <Button variant="outline" size="sm" onClick={handleSyncNFEntrada} disabled={syncing}>
                  {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                  Atualizar
                </Button>
              </CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-xs">Produto</TableHead>
                  <TableHead className="text-xs">Fornecedor / NF</TableHead>
                  <TableHead className="text-xs">NCM</TableHead>
                  <TableHead className="text-xs text-right">Valor Unit.</TableHead>
                  <TableHead className="text-xs text-right">ICMS %</TableHead>
                  <TableHead className="text-xs text-right">PIS %</TableHead>
                  <TableHead className="text-xs text-right">COFINS %</TableHead>
                  <TableHead className="text-xs text-right">IPI %</TableHead>
                  <TableHead className="text-xs text-right">Frete %</TableHead>
                  <TableHead className="text-xs text-right font-semibold text-primary">Custo Efetivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(!tributos || tributos.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
                      Nenhum tributo de NF de entrada encontrado. Clique em "Sync NFs Entrada" para importar.
                    </TableCell>
                  </TableRow>
                )}
                {tributos?.map((t) => (
                  <TableRow key={t.gc_produto_id} className="border-border">
                    <TableCell>
                      <span className="font-medium text-foreground text-sm">{t.nome_produto}</span>
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <span className="text-foreground">{t.fornecedor_nome || "—"}</span>
                        {t.nf_numero && (
                          <span className="text-muted-foreground ml-1">NF #{t.nf_numero}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{t.ncm || "—"}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(t.valor_unitario_nf)}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.icms_aliquota}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.pis_aliquota}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.cofins_aliquota}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.ipi_aliquota}%</TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.frete_percentual}%</TableCell>
                    <TableCell className="text-right font-mono text-sm font-bold text-primary">
                      {formatCurrency(t.custo_efetivo_unit)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
