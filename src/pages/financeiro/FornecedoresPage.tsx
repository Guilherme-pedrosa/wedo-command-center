import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { Search, Building, ChevronRight, Mail, Phone, MapPin, ArrowLeft, Key } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function FornecedoresPage() {
  const [busca, setBusca] = useState("");
  const [fornecedorSel, setFornecedorSel] = useState<any>(null);

  const { data: fornecedores = [] } = useQuery({
    queryKey: ["fin-fornecedores"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_fornecedores" as any)
        .select("*")
        .order("nome");
      return (data || []) as any[];
    },
  });

  const { data: pagamentos = [] } = useQuery({
    queryKey: ["fin-pagamentos-fornecedor", fornecedorSel?.gc_id],
    enabled: !!fornecedorSel,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_pagamentos" as any)
        .select("*")
        .eq("fornecedor_gc_id", fornecedorSel.gc_id)
        .order("data_vencimento", { ascending: false });
      return (data || []) as any[];
    },
  });

  const filtrados = useMemo(() => {
    if (!busca.trim()) return fornecedores;
    const t = busca.toLowerCase();
    return fornecedores.filter((f: any) =>
      f.nome?.toLowerCase().includes(t) ||
      f.cpf_cnpj?.includes(t) ||
      f.email?.toLowerCase().includes(t) ||
      f.cidade?.toLowerCase().includes(t)
    );
  }, [fornecedores, busca]);

  const totalPago = pagamentos.filter((p: any) => p.liquidado).reduce((s: number, p: any) => s + Number(p.valor || 0), 0);
  const totalPendente = pagamentos.filter((p: any) => !p.liquidado).reduce((s: number, p: any) => s + Number(p.valor || 0), 0);

  if (fornecedorSel) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setFornecedorSel(null)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
          </Button>
          <h1 className="text-xl font-bold text-foreground">{fornecedorSel.nome}</h1>
          {fornecedorSel.tipo_pessoa && (
            <Badge variant="outline" className="capitalize">{fornecedorSel.tipo_pessoa === "juridica" ? "PJ" : "PF"}</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-4 space-y-2 text-sm">
              {fornecedorSel.cpf_cnpj && <div className="text-muted-foreground">CPF/CNPJ: <span className="text-foreground">{fornecedorSel.cpf_cnpj}</span></div>}
              {fornecedorSel.razao_social && <div className="text-muted-foreground">Razão Social: <span className="text-foreground">{fornecedorSel.razao_social}</span></div>}
              {fornecedorSel.email && <div className="flex items-center gap-1.5 text-muted-foreground"><Mail className="h-3 w-3" /><span className="text-foreground">{fornecedorSel.email}</span></div>}
              {fornecedorSel.telefone && <div className="flex items-center gap-1.5 text-muted-foreground"><Phone className="h-3 w-3" /><span className="text-foreground">{fornecedorSel.telefone}</span></div>}
              {fornecedorSel.chave_pix && <div className="flex items-center gap-1.5 text-muted-foreground"><Key className="h-3 w-3" /><span className="text-foreground">{fornecedorSel.chave_pix}</span></div>}
              {(fornecedorSel.cidade || fornecedorSel.estado) && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="h-3 w-3" />
                  <span className="text-foreground">{[fornecedorSel.endereco, fornecedorSel.bairro, fornecedorSel.cidade, fornecedorSel.estado].filter(Boolean).join(", ")}</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 text-center">
              <div className="text-2xl font-bold text-red-500">{formatCurrency(totalPago)}</div>
              <div className="text-xs text-muted-foreground mt-1">Total Pago</div>
              <div className="text-sm text-muted-foreground mt-2">{pagamentos.filter((p: any) => p.liquidado).length} lançamentos pagos</div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 text-center">
              <div className="text-2xl font-bold text-yellow-500">{formatCurrency(totalPendente)}</div>
              <div className="text-xs text-muted-foreground mt-1">A Pagar (pendente)</div>
              <div className="text-sm text-muted-foreground mt-2">{pagamentos.filter((p: any) => !p.liquidado).length} lançamentos abertos</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Histórico de Pagamentos ({pagamentos.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[400px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data Venc.</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Liquidação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagamentos.map((p: any) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-xs">{formatDate(p.data_vencimento)}</TableCell>
                      <TableCell className="text-xs max-w-[250px] truncate">{p.descricao}</TableCell>
                      <TableCell className="text-xs text-right font-medium">{formatCurrency(p.valor)}</TableCell>
                      <TableCell>
                        <Badge variant={p.liquidado ? "default" : "secondary"} className="text-[10px]">
                          {p.liquidado ? "Pago" : "Pendente"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{p.data_liquidacao ? formatDate(p.data_liquidacao) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {pagamentos.length === 0 && (
                    <TableRow><TableCell colSpan={5} className="text-center text-muted-foreground py-8">Nenhum pagamento encontrado</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </ScrollArea>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Fornecedores</h1>
          <Badge variant="secondary">{fornecedores.length}</Badge>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar por nome, CPF/CNPJ, email, cidade..."
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="pl-9"
        />
      </div>

      <Card>
        <CardContent className="p-0">
          <ScrollArea className="h-[calc(100vh-220px)]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>CPF/CNPJ</TableHead>
                  <TableHead>Cidade/UF</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Telefone</TableHead>
                  <TableHead className="w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtrados.map((f: any) => (
                  <TableRow
                    key={f.id}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => setFornecedorSel(f)}
                  >
                    <TableCell className="font-medium text-sm">{f.nome}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.cpf_cnpj || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{[f.cidade, f.estado].filter(Boolean).join("/") || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.email || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{f.telefone || "—"}</TableCell>
                    <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                  </TableRow>
                ))}
                {filtrados.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Nenhum fornecedor encontrado</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
