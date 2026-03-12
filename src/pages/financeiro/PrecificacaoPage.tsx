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
import { Loader2, Search, Calculator, Package, TrendingUp, AlertTriangle, DollarSign, BarChart3, RefreshCw, FileText, Info, ShoppingCart, Wrench, Upload } from "lucide-react";
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
  cfop: string | null;
  nf_numero: string | null;
  nf_chave: string | null;
  nf_data_emissao: string | null;
  fornecedor_nome: string | null;
  regime_fornecedor: string | null;
  sem_credito: boolean | null;
  icms_aliquota: number;
  icms_aliquota_manual: number | null;
  pis_aliquota: number;
  pis_aliquota_manual: number | null;
  cofins_aliquota: number;
  cofins_aliquota_manual: number | null;
  ipi_aliquota: number;
  ipi_aliquota_manual: number | null;
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
  icmsSaida: 8.8,
  pisSaida: 1.65,
  cofinsSaida: 7.6,
  iss: 3.65,
  pisSaidaServico: 1.65,
  cofinsSaidaServico: 7.6,
  irpjCsll: 0, // Desconsiderado no custo da peça — incide sobre lucro da empresa, não do produto
};

// ── Helpers ──
function calcPricing(
  custoBruto: number,
  entrada: TaxConfigEntrada,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  margemDesejada: number
) {
  // Créditos de entrada — serviço não aproveita ICMS
  const creditoIcms = tipo === "servico" ? 0 : custoBruto * (entrada.icmsCredito / 100);
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

// Get effective aliquota (manual override > NF sync value; sem_credito zeroes all)
function getEffectiveRates(t: ProdutoTributo) {
  const semCredito = t.sem_credito || t.regime_fornecedor === "simples_nacional";
  return {
    icms: semCredito ? 0 : (t.icms_aliquota_manual ?? t.icms_aliquota),
    pis: semCredito ? 0 : (t.pis_aliquota_manual ?? t.pis_aliquota),
    cofins: semCredito ? 0 : (t.cofins_aliquota_manual ?? t.cofins_aliquota),
    ipi: t.ipi_aliquota_manual ?? t.ipi_aliquota,
    semCredito,
  };
}

function calcPricingWithNF(
  tributo: ProdutoTributo,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  custoFixo: number,
  margemDesejada: number
) {
  const eff = getEffectiveRates(tributo);
  const valorUnit = tributo.valor_unitario_nf;
  
  // Recalculate credits based on effective rates — serviço não aproveita ICMS
  const creditoIcms = tipo === "servico" ? 0 : valorUnit * (eff.icms / 100);
  const creditoPis = valorUnit * (eff.pis / 100);
  const creditoCofins = valorUnit * (eff.cofins / 100);
  const ipiUnit = tributo.valor_ipi_unit;
  const freteUnit = tributo.valor_frete_unit;
  
  // Custo efetivo recalculado com alíquotas efetivas
  const custoEfetivo = valorUnit + ipiUnit + freteUnit - creditoIcms - creditoPis - creditoCofins;
  const custoTotal = custoEfetivo + custoFixo;

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
    creditoIcms,
    creditoPis,
    creditoCofins,
    totalCreditosEntrada: creditoIcms + creditoPis + creditoCofins,
    custoEfetivo,
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
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });


  const { data: tributos, refetch: refetchTributos } = useQuery({
    queryKey: ["produto-tributos"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: ProdutoTributo[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("fin_produto_tributos")
          .select("*")
          .order("nome_produto")
          .range(from, from + pageSize - 1);

        if (error) throw error;

        const batch = (data || []) as ProdutoTributo[];
        allRows.push(...batch);

        if (batch.length < pageSize) break;
        from += pageSize;
      }

      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  // Índice de XMLs realmente enviados/processados
  const { data: xmlIndexRows } = useQuery({
    queryKey: ["nfe-xml-index-keys"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: { chave: string | null }[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("fin_nfe_xml_index")
          .select("chave")
          .range(from, from + pageSize - 1);

        if (error) throw error;

        const batch = (data || []) as { chave: string | null }[];
        allRows.push(...batch);

        if (batch.length < pageSize) break;
        from += pageSize;
      }

      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  const indexedNfChaves = useMemo(() => {
    return new Set(
      (xmlIndexRows || [])
        .map((r) => r.chave)
        .filter((c): c is string => Boolean(c))
    );
  }, [xmlIndexRows]);

  // Mantém apenas tributos com NF que existe no índice de XML de entrada
  const tributosXml = useMemo(() => {
    return (tributos || []).filter(
      (t) => Boolean(t.nf_chave) && indexedNfChaves.has(t.nf_chave as string)
    );
  }, [tributos, indexedNfChaves]);

  const tributosMap = useMemo(() => {
    const map = new Map<string, ProdutoTributo>();
    tributosXml.forEach((t) => map.set(t.gc_produto_id, t));
    return map;
  }, [tributosXml]);

  // ── Fetch monthly fixed costs using same logic as Resultados Operação ──
  const now = new Date();
  const { data: custoFixoMensal } = useQuery({
    queryKey: ["custo-fixo-mensal-resultados", now.getFullYear(), now.getMonth() + 1],
    queryFn: async () => {
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const end = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;

      // 1) Fetch active metas of category 'custo_fixo'
      const { data: metas } = await supabase.from("fin_metas").select("id, nome, categoria").eq("ativo", true).eq("categoria", "custo_fixo");
      if (!metas || metas.length === 0) return 0;

      // 2) Fetch plano_contas mappings for these metas
      const metaIds = metas.map(m => m.id);
      const { data: links } = await supabase.from("fin_meta_plano_contas").select("meta_id, plano_contas_id, centro_custo_id, peso").in("meta_id", metaIds);
      if (!links || links.length === 0) return 0;

      // 3) Build plano UUID → GC ID map
      const { data: planos } = await supabase.from("fin_plano_contas").select("id, gc_id");
      const uuidToGcId: Record<string, string> = {};
      for (const p of (planos || [])) { if (p.gc_id) uuidToGcId[p.id] = p.gc_id; }

      // 4) Build centro_custo UUID → codigo map
      const { data: centros } = await supabase.from("fin_centros_custo").select("id, codigo");
      const centroMap: Record<string, string> = {};
      for (const c of (centros || [])) { if (c.codigo) centroMap[c.id] = c.codigo; }

      // 5) Fetch GC pagamentos for the period
      const { data: gcPag } = await supabase.from("gc_pagamentos")
        .select("valor, plano_contas_id, centro_custo_id")
        .gte("data_vencimento", start).lte("data_vencimento", end);

      // 6) Fetch Auvo expenses for the period
      const { data: auvoExp } = await supabase.from("auvo_expenses_sync")
        .select("type_id, amount")
        .gte("expense_date", start).lte("expense_date", end);

      // Auvo typeId → plano gc_id mapping (same as hook)
      const AUVO_SOURCE_MAP: Record<string, number[]> = {
        '27867667': [48782], '27912040': [48784], '28160784': [49032], '28223100': [49032],
      };

      // 7) Calculate realized for each custo_fixo meta
      let totalFixo = 0;
      for (const meta of metas) {
        const metaLinks = links.filter(l => l.meta_id === meta.id);
        for (const link of metaLinks) {
          const gcId = uuidToGcId[link.plano_contas_id];
          const auvoTypeIds = gcId ? AUVO_SOURCE_MAP[gcId] : undefined;
          const centroCodigo = link.centro_custo_id ? centroMap[link.centro_custo_id] : null;

          if (auvoTypeIds && auvoExp && auvoExp.length > 0) {
            const auvoSum = auvoExp
              .filter((e: any) => auvoTypeIds.includes(e.type_id))
              .reduce((acc: number, e: any) => acc + (Number(e.amount) || 0), 0);
            totalFixo += auvoSum * (link.peso || 1);
          } else if (gcId && gcPag) {
            const soma = gcPag
              .filter((r: any) => r.plano_contas_id === gcId &&
                (!centroCodigo || !r.centro_custo_id || r.centro_custo_id === centroCodigo))
              .reduce((acc: number, r: any) => acc + Math.abs(r.valor || 0), 0);
            totalFixo += soma * (link.peso || 1);
          }
        }
      }
      return totalFixo;
    },
    staleTime: 10 * 60_000,
  });

  // ── Filtered products (works with or without GC products loaded) ──
  const EXCLUDED_GROUPS = ["ferramentas"];
  const EXCLUDED_NAME_KEYWORDS = ["consignado", "garantia metalfrio"];
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    if (produtos) {
      return produtos
        .filter((p) => {
          if (!tributosMap.has(p.id)) return false;
          if (EXCLUDED_GROUPS.includes((p.nome_grupo || "").toLowerCase())) return false;
          const nome = (p.nome || "").toLowerCase();
          if (EXCLUDED_NAME_KEYWORDS.some(k => nome.includes(k))) return false;
          const codigo = (p.codigo || p.codigo_interno || "").toLowerCase();
          return nome.includes(q) || codigo.includes(q);
        })
        .slice(0, 100);
    }
    // Sem produtos GC carregados → lista vazia (não usar NF como fallback)
    return [];
  }, [produtos, search, tributosMap]);

  const totalProdutosEstoque = useMemo(() => {
    if (!produtos) return null; // sem dados de estoque carregados
    return produtos
      .filter(p => !EXCLUDED_GROUPS.includes((p.nome_grupo || "").toLowerCase()))
      .reduce((sum, p) => sum + (Number(p.estoque) || 0), 0) || 1;
  }, [produtos]);

  // Custo fixo só é rateado se temos dados de estoque; caso contrário, só usa override manual
  const custoFixoAutoUnit = (custoFixoMensal && totalProdutosEstoque) ? custoFixoMensal / totalProdutosEstoque : 0;
  const activeEntrada = { ...taxEntrada, custoFixoUnit: taxEntrada.custoFixoUnit || custoFixoAutoUnit };

  // ── Upload XMLs de NF para o bucket (suporta ZIP + lotes) ──
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  
  const extractXmlsFromZip = async (
    file: File | Blob,
    basePath = "",
    depth = 0
  ): Promise<{ xmlFiles: { name: string; blob: Blob }[]; totalEntries: number; nestedZips: number }> => {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(file);
    const xmlFiles: { name: string; blob: Blob }[] = [];

    let totalEntries = 0;
    let nestedZips = 0;
    const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);

    totalEntries += entries.length;

    for (const [name, entry] of entries) {
      const lower = name.toLowerCase();

      if (lower.endsWith(".xml")) {
        const blob = await entry.async("blob");
        xmlFiles.push({ name: `${basePath}${name}`, blob });
        continue;
      }

      // Alguns lotes da SEFAZ vêm com ZIP dentro de ZIP
      if (lower.endsWith(".zip") && depth < 4) {
        nestedZips++;
        const nestedBlob = await entry.async("blob");
        const nested = await extractXmlsFromZip(
          nestedBlob,
          `${basePath}${name.replace(/\.zip$/i, "")}/`,
          depth + 1
        );
        xmlFiles.push(...nested.xmlFiles);
        totalEntries += nested.totalEntries;
        nestedZips += nested.nestedZips;
      }
    }

    return { xmlFiles, totalEntries, nestedZips };
  };

  const parseXmlMetadata = async (blob: Blob): Promise<{
    chave: string | null;
    cnpj_emitente: string | null;
    nome_emitente: string | null;
    data_emissao: string | null;
    valor_total: number | null;
    valor_produtos: number | null;
    qtd_itens: number;
  }> => {
    const text = await blob.text();
    const chaveMatch = text.match(/Id="NFe(\d{44})"/i) || text.match(/chNFe>(\d{44})</i);
    const chave = chaveMatch?.[1] || null;

    // Extract emit block
    const emitMatch = text.match(/<emit[^>]*>([\s\S]*?)<\/emit>/i);
    const emitBlock = emitMatch?.[1] || "";
    const cnpjMatch = emitBlock.match(/<CNPJ[^>]*>(\d+)<\/CNPJ>/i);
    const cnpj_emitente = cnpjMatch?.[1] || null;
    const nomeMatch = emitBlock.match(/<xNome[^>]*>([^<]+)<\/xNome>/i);
    const nome_emitente = nomeMatch?.[1] || null;

    // Extract data emissão
    const dhEmiMatch = text.match(/<dhEmi[^>]*>([^<]+)<\/dhEmi>/i) || text.match(/<dEmi[^>]*>([^<]+)<\/dEmi>/i);
    const data_emissao = dhEmiMatch?.[1]?.substring(0, 10) || null;

    // Extract totals from ICMSTot
    const vNFMatch = text.match(/<vNF[^>]*>([^<]+)<\/vNF>/i);
    const valor_total = vNFMatch ? parseFloat(vNFMatch[1]) : null;
    const vProdMatch = text.match(/<vProd[^>]*>([^<]+)<\/vProd>/i);
    const valor_produtos = vProdMatch ? parseFloat(vProdMatch[1]) : null;

    // Count det items
    const detMatches = text.match(/<det /gi) || text.match(/<det>/gi) || [];
    const qtd_itens = detMatches.length;

    return { chave, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens };
  };

  const uploadBatch = async (
    items: { name: string; blob: Blob }[],
    batchSize: number,
    onProgress: (done: number, total: number) => void
  ) => {
    let uploaded = 0;
    let repeatedKeys = 0;
    let indexed = 0;
    let errors = 0;
    const total = items.length;
    const keyOccurrences = new Map<string, number>();
    const indexBatch: Record<string, unknown>[] = [];

    for (let i = 0; i < total; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const meta = await parseXmlMetadata(item.blob);

          let path = item.name.replace(/^.*[\\/]/, "");
          if (meta.chave) {
            const count = (keyOccurrences.get(meta.chave) || 0) + 1;
            keyOccurrences.set(meta.chave, count);

            if (count === 1) {
              path = `${meta.chave}.xml`;
            } else {
              repeatedKeys++;
              path = `repetidos/${meta.chave}-${count}.xml`;
            }
          }

          const { error } = await supabase.storage.from("nf-xmls").upload(path, item.blob, {
            contentType: "text/xml",
            upsert: true,
          });
          if (error) throw error;

          // Collect index data for first occurrence only
          if (meta.chave && (keyOccurrences.get(meta.chave) || 0) <= 1) {
            indexBatch.push({
              chave: meta.chave,
              cnpj_emitente: meta.cnpj_emitente,
              nome_emitente: meta.nome_emitente,
              data_emissao: meta.data_emissao,
              valor_total: meta.valor_total,
              valor_produtos: meta.valor_produtos,
              qtd_itens: meta.qtd_itens,
              storage_path: path,
            });
          }

          return "uploaded" as const;
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value === "uploaded") uploaded++;
        } else {
          errors++;
          console.error("Upload error:", r.reason);
        }
      }

      // Upsert index in batches of 50
      if (indexBatch.length >= 50) {
        const toUpsert = indexBatch.splice(0, 50);
        const { error: idxErr, data: idxData } = await supabase
          .from("fin_nfe_xml_index")
          .upsert(toUpsert as any, { onConflict: "chave" });
        if (!idxErr) indexed += toUpsert.length;
        else console.error("Index upsert error:", idxErr.message);
      }

      onProgress(uploaded + errors, total);
    }

    // Flush remaining index records
    if (indexBatch.length > 0) {
      const { error: idxErr } = await supabase
        .from("fin_nfe_xml_index")
        .upsert(indexBatch as any, { onConflict: "chave" });
      if (!idxErr) indexed += indexBatch.length;
    }

    return { uploaded, repeatedKeys, errors, indexed };
  };

  const handleUploadXmls = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress("Preparando arquivos...");

    try {
      // Heurística: alguns navegadores limitam seleção múltipla em ~1000 arquivos
      if (files.length === 1000) {
        toast("Se você selecionou mais de 1000, prefira ZIP para enviar tudo de uma vez.");
      }

      // Collect all XML items (from .xml files and from .zip files)
      const allItems: { name: string; blob: Blob }[] = [];
      let totalZipEntries = 0;
      let totalNestedZips = 0;

      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          setUploadProgress(`Extraindo ${file.name}...`);
          const zipResult = await extractXmlsFromZip(file);
          allItems.push(...zipResult.xmlFiles);
          totalZipEntries += zipResult.totalEntries;
          totalNestedZips += zipResult.nestedZips;
          setUploadProgress(`Encontrados ${zipResult.xmlFiles.length} XML(s) em ${file.name}`);
        } else {
          allItems.push({ name: file.name, blob: file });
        }
      }

      if (allItems.length === 0) {
        toast.error("Nenhum XML encontrado nos arquivos selecionados");
        return;
      }

      if (totalZipEntries > 0) {
        toast(
          `Diagnóstico ZIP: ${totalZipEntries} entrada(s), ${allItems.length} XML(s)` +
            (totalNestedZips > 0 ? `, ${totalNestedZips} ZIP(ns) interno(s)` : "")
        );
      }

      setUploadProgress(`0 / ${allItems.length} processados`);
      const BATCH_SIZE = 15;
      const { uploaded, repeatedKeys, errors, indexed } = await uploadBatch(allItems, BATCH_SIZE, (done, total) => {
        setUploadProgress(`${done} / ${total} processados`);
      });

      toast.success(
        `${uploaded} arquivo(s) enviados, ${indexed} indexados` +
          (repeatedKeys > 0 ? `, ${repeatedKeys} chave(s) repetida(s)` : "") +
          (errors > 0 ? `, ${errors} erro(s)` : "")
      );
    } catch (err) {
      toast.error(`Erro no upload: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      setUploadProgress("");
      e.target.value = "";
    }
  };

  // ── Sync NFs de entrada via API GC ──
  const handleSyncGC = async () => {
    const { checkSyncCooldown, markSyncStarted } = await import("@/lib/gc-client");
    const cooldown = checkSyncCooldown("sync-nfe-entrada-gc");
    if (!cooldown.allowed) {
      toast.error(`Aguarde ${Math.ceil(cooldown.remainingSeconds / 60)} minuto(s) antes de sincronizar novamente.`);
      return;
    }
    markSyncStarted("sync-nfe-entrada-gc");
    setSyncing(true);
    setSyncProgress("Sincronizando com GC...");
    try {
      let offset = 0;
      const batchSize = 80;
      let totalProdutos = 0;
      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
          body: { offset, batch_size: batchSize },
        });
        if (error) throw error;
        totalProdutos += data.produtos_processados || 0;
        setSyncProgress(`Processando lote ${offset}...`);
        if (!data.has_more) break;
        offset = data.next_offset;
      }
      toast.success(`Sincronizado (GC): ${totalProdutos} produtos processados`);
      setSyncProgress("");
      refetchTributos();
    } catch (err: unknown) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      setSyncProgress("");
    } finally {
      setSyncing(false);
    }
  };

  // ── Sync NFs de entrada OFFLINE (usa BD local + XMLs, sem chamar API GC) ──
  const [syncProgress, setSyncProgress] = useState("");
  const handleSyncNFEntrada = async () => {
    // Cooldown check
    const { checkSyncCooldown, markSyncStarted } = await import("@/lib/gc-client");
    const cooldown = checkSyncCooldown("sync-nfe-entrada");
    if (!cooldown.allowed) {
      toast.error(`Aguarde ${Math.ceil(cooldown.remainingSeconds / 60)} minuto(s) antes de sincronizar novamente.`);
      return;
    }
    markSyncStarted("sync-nfe-entrada");

    setSyncing(true);
    setSyncProgress("Iniciando (modo offline)...");
    try {
      let offset = 0;
      const batchSize = 80;
      let totalProdutos = 0;
      let totalCompras = 0;
      let totalXmls = 0;

      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada-offline", {
          body: { offset, batch_size: batchSize },
        });
        if (error) throw error;
        
        totalCompras = data.total_compras || 0;
        totalProdutos += data.produtos_processados || 0;
        totalXmls += data.xmls_usados || 0;
        const processed = offset + (data.processed || 0);
        setSyncProgress(`Processando compras ${processed}/${totalCompras}...`);
        
        if (!data.has_more) break;
        offset = data.next_offset;
      }

      toast.success(`Sincronizado (offline): ${totalProdutos} produtos de ${totalCompras} compras (${totalXmls} XMLs usados)`);
      setSyncProgress("");
      refetchTributos();
    } catch (err: unknown) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      setSyncProgress("");
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

  const totalComTributoNF = tributosXml.length;

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
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleSyncGC} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Sync NFs Entrada (GC)
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncNFEntrada} disabled={syncing}>
              {syncing ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Reprocessar Tributos
            </Button>
            {syncing && syncProgress && (
              <span className="text-xs text-muted-foreground font-mono animate-pulse">{syncProgress}</span>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={uploading} asChild>
            <label className="cursor-pointer">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
              {uploading && uploadProgress ? uploadProgress : "Upload XMLs / ZIP"}
              <input type="file" accept=".xml,.zip" multiple className="hidden" onChange={handleUploadXmls} />
            </label>
          </Button>
          {syncing && syncProgress && (
            <span className="text-xs text-muted-foreground animate-pulse">{syncProgress}</span>
          )}
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
            </strong>: {getTipoSaidaAliquota(tipoSaidaGlobal)}
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
                  <TableHead className="text-xs text-right font-semibold text-primary">Preço Mín.</TableHead>
                  <TableHead className="text-xs text-right">Venda GC</TableHead>
                  <TableHead className="text-xs text-center">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && !loadingProdutos && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground py-8">
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
                      creditoIcms: nfCalc.creditoIcms,
                      creditoPis: nfCalc.creditoPis,
                      creditoCofins: nfCalc.creditoCofins,
                      totalCreditosEntrada: nfCalc.totalCreditosEntrada,
                      custoLiquido: nfCalc.custoEfetivo,
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
                        const lucro = vendaGC - calc.custoTotal - tribSaida;
                        return (lucro / vendaGC) * 100;
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
                              {(() => {
                                const nfNum = tributo.nf_numero || (tributo.nf_chave?.length === 44 ? String(parseInt(tributo.nf_chave.substring(25, 34))) : "");
                                return (
                                  <Badge className={`text-[10px] gap-1 ${
                                    tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito
                                      ? "bg-amber-500/20 text-amber-400"
                                      : "bg-primary/20 text-primary"
                                  }`}>
                                    <FileText className="h-3 w-3" />
                                    {tributo.fornecedor_nome || "NF"}
                                    {nfNum ? ` #${nfNum}` : ""}
                                    {(tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito) ? " ·SN" : ""}
                                  </Badge>
                                );
                              })()}
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-sm">
                              <p className="font-semibold">NF #{tributo.nf_numero} — {tributo.fornecedor_nome}</p>
                              {(tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito) && (
                                <p className="text-amber-400 font-semibold">⚠ Simples Nacional — Sem créditos de entrada</p>
                              )}
                              {(() => { const eff = getEffectiveRates(tributo); return (
                                <>
                                  <p>ICMS: {eff.icms}% · PIS: {eff.pis}% · COFINS: {eff.cofins}%</p>
                                  <p>IPI: {eff.ipi}% · Frete: {tributo.frete_percentual}%</p>
                                </>
                              ); })()}
                              <p>CFOP: {tributo.cfop || "—"}</p>
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

          <p className="text-xs text-muted-foreground">
            {produtos ? `${produtos.length} produtos GC · ` : "Modo offline (sem dados de estoque) · "}
            {totalComTributoNF} com tributo NF · Mostrando {filtered.length} · Tipo saída: {getTipoSaidaLabel(tipoSaidaGlobal)}
          </p>
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
                  <Badge variant="outline" className="text-[10px]">
                    Clique na alíquota para editar · Marque "SN" para Simples Nacional
                  </Badge>
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
                  <TableHead className="text-xs text-center">Regime</TableHead>
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
                {tributosXml.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      Nenhum tributo com XML de entrada indexado encontrado. Clique em "Sync NFs Entrada" para importar.
                    </TableCell>
                  </TableRow>
                )}
                {tributosXml.map((t) => {
                  const eff = getEffectiveRates(t);
                  // Recalculate effective cost
                  const effCreditoIcms = t.valor_unitario_nf * (eff.icms / 100);
                  const effCreditoPis = t.valor_unitario_nf * (eff.pis / 100);
                  const effCreditoCofins = t.valor_unitario_nf * (eff.cofins / 100);
                  const effCustoEfetivo = t.valor_unitario_nf + t.valor_ipi_unit + t.valor_frete_unit - effCreditoIcms - effCreditoPis - effCreditoCofins;
                  
                  return (
                  <TableRow key={t.gc_produto_id} className={`border-border ${eff.semCredito ? "bg-amber-500/5" : ""}`}>
                    <TableCell>
                      <span className="font-medium text-foreground text-sm">{t.nome_produto}</span>
                      {t.cfop && <span className="text-[10px] text-muted-foreground ml-1">CFOP {t.cfop}</span>}
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
                    <TableCell className="text-center">
                      <Button
                        variant={eff.semCredito ? "default" : "outline"}
                        size="sm"
                        className={`text-[10px] h-6 px-2 ${eff.semCredito ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border-amber-500/30" : ""}`}
                        onClick={async () => {
                          const newSemCredito = !eff.semCredito;
                          const { error } = await supabase
                            .from("fin_produto_tributos")
                            .update({ 
                              sem_credito: newSemCredito,
                              regime_fornecedor: newSemCredito ? "simples_nacional" : "normal"
                            })
                            .eq("gc_produto_id", t.gc_produto_id);
                          if (!error) {
                            refetchTributos();
                            toast.success(newSemCredito ? "Marcado como Simples Nacional" : "Regime alterado para Normal");
                          }
                        }}
                      >
                        {eff.semCredito ? "SN ✓" : "Normal"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(t.valor_unitario_nf)}</TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.icms} originalValue={t.icms_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ icms_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.pis} originalValue={t.pis_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ pis_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.cofins} originalValue={t.cofins_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ cofins_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.ipi} originalValue={t.ipi_aliquota}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ ipi_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.frete_percentual}%</TableCell>
                    <TableCell className="text-right font-mono text-sm font-bold text-primary">
                      {formatCurrency(effCustoEfetivo)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Editable Rate Component ──
function EditableRate({ value, originalValue, disabled, onSave }: {
  value: number;
  originalValue: number;
  disabled?: boolean;
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value));
  const isOverridden = value !== originalValue;

  if (disabled) {
    return <span className="font-mono text-sm text-muted-foreground">0%</span>;
  }

  if (editing) {
    return (
      <Input
        type="number"
        step="0.01"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={async () => {
          const parsed = parseFloat(editValue);
          if (!isNaN(parsed) && parsed !== originalValue) {
            await onSave(parsed);
          } else if (parsed === originalValue) {
            await onSave(null); // remove override
          }
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        className="h-6 w-16 text-xs font-mono bg-secondary text-right p-1"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditValue(String(value)); setEditing(true); }}
      className={`font-mono text-sm cursor-pointer hover:underline ${isOverridden ? "text-blue-400 font-semibold" : ""}`}
      title={isOverridden ? `Original: ${originalValue}% · Editado: ${value}%` : "Clique para editar"}
    >
      {value}%
    </button>
  );
}
