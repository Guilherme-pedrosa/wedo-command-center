import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatCurrency, formatDate } from "@/lib/format";
import { Search, Users, ChevronRight, Mail, Phone, MapPin, ArrowLeft, Receipt } from "lucide-react";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";

export default function ClientesPage() {
  const [busca, setBusca] = useState("");
  const [clienteSel, setClienteSel] = useState<any>(null);

  const { data: clientes = [] } = useQuery({
    queryKey: ["fin-clientes"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_clientes" as any)
        .select("*")
        .order("nome");
      return (data || []) as any[];
    },
  });

  const { data: recebimentos = [] } = useQuery({
    queryKey: ["fin-recebimentos-clientes", clienteSel?.gc_id],
    enabled: !!clienteSel,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_recebimentos" as any)
        .select("*")
        .eq("cliente_gc_id", clienteSel.gc_id)
        .order("data_vencimento", { ascending: false });
      return (data || []) as any[];
    },
  });

  const filtrados = useMemo(() => {
    if (!busca.trim()) return clientes;
    const t = busca.toLowerCase();
    return clientes.filter((c: any) =>
      c.nome?.toLowerCase().includes(t) ||
      c.cpf_cnpj?.includes(t) ||
      c.email?.toLowerCase().includes(t) ||
      c.cidade?.toLowerCase().includes(t)
    );
  }, [clientes, busca]);

  const totalRecebido = recebimentos.filter((r: any) => r.liquidado).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
  const totalPendente = recebimentos.filter((r: any) => !r.liquidado).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);

  if (clienteSel) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => setClienteSel(null)}>
            <ArrowLeft className="h-4 w-4 mr-1" /> Voltar
          </Button>
          <h1 className="text-xl font-bold text-foreground">{clienteSel.nome}</h1>
          {clienteSel.tipo_pessoa && (
            <Badge variant="outline" className="capitalize">{clienteSel.tipo_pessoa === "juridica" ? "PJ" : "PF"}</Badge>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-4 space-y-2 text-sm">
              {clienteSel.cpf_cnpj && <div className="text-muted-foreground">CPF/CNPJ: <span className="text-foreground">{clienteSel.cpf_cnpj}</span></div>}
              {clienteSel.razao_social && <div className="text-muted-foreground">Razão Social: <span className="text-foreground">{clienteSel.razao_social}</span></div>}
              {clienteSel.email && <div className="flex items-center gap-1.5 text-muted-foreground"><Mail className="h-3 w-3" /><span className="text-foreground">{clienteSel.email}</span></div>}
              {clienteSel.telefone && <div className="flex items-center gap-1.5 text-muted-foreground"><Phone className="h-3 w-3" /><span className="text-foreground">{clienteSel.telefone}</span></div>}
              {(clienteSel.cidade || clienteSel.estado) && (
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <MapPin className="h-3 w-3" />
                  <span className="text-foreground">{[clienteSel.endereco, clienteSel.bairro, clienteSel.cidade, clienteSel.estado].filter(Boolean).join(", ")}</span>
                </div>
              )}
              {clienteSel.cep && <div className="text-muted-foreground">CEP: <span className="text-foreground">{clienteSel.cep}</span></div>}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 text-center">
              <div className="text-2xl font-bold text-green-500">{formatCurrency(totalRecebido)}</div>
              <div className="text-xs text-muted-foreground mt-1">Total Recebido</div>
              <div className="text-sm text-muted-foreground mt-2">{recebimentos.filter((r: any) => r.liquidado).length} lançamentos pagos</div>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-4 text-center">
              <div className="text-2xl font-bold text-yellow-500">{formatCurrency(totalPendente)}</div>
              <div className="text-xs text-muted-foreground mt-1">A Receber (pendente)</div>
              <div className="text-sm text-muted-foreground mt-2">{recebimentos.filter((r: any) => !r.liquidado).length} lançamentos abertos</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Histórico de Recebimentos ({recebimentos.length})</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[400px]">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Data Venc.</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>OS</TableHead>
                    <TableHead className="text-right">Valor</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Liquidação</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recebimentos.map((r: any) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-xs">{formatDate(r.data_vencimento)}</TableCell>
                      <TableCell className="text-xs max-w-[200px] truncate">{r.descricao}</TableCell>
                      <TableCell className="text-xs">{r.os_codigo || "—"}</TableCell>
                      <TableCell className="text-xs text-right font-medium">{formatCurrency(r.valor)}</TableCell>
                      <TableCell>
                        <Badge variant={r.liquidado ? "default" : "secondary"} className="text-[10px]">
                          {r.liquidado ? "Pago" : "Pendente"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-xs">{r.data_liquidacao ? formatDate(r.data_liquidacao) : "—"}</TableCell>
                    </TableRow>
                  ))}
                  {recebimentos.length === 0 && (
                    <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Nenhum recebimento encontrado</TableCell></TableRow>
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
          <Users className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">Clientes</h1>
          <Badge variant="secondary">{clientes.length}</Badge>
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
                {filtrados.map((c: any) => (
                  <TableRow
                    key={c.id}
                    className="cursor-pointer hover:bg-accent/50"
                    onClick={() => setClienteSel(c)}
                  >
                    <TableCell className="font-medium text-sm">{c.nome}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.cpf_cnpj || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{[c.cidade, c.estado].filter(Boolean).join("/") || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.email || "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{c.telefone || "—"}</TableCell>
                    <TableCell><ChevronRight className="h-4 w-4 text-muted-foreground" /></TableCell>
                  </TableRow>
                ))}
                {filtrados.length === 0 && (
                  <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">Nenhum cliente encontrado</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
