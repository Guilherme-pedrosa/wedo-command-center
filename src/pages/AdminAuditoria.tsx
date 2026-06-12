import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, Search, Shield, Eye, RefreshCw } from "lucide-react";

const ACTION_COLOR: Record<string, string> = {
  INSERT: "bg-emerald-500/20 text-emerald-600 border-emerald-500/30",
  UPDATE: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  DELETE: "bg-destructive/20 text-destructive border-destructive/30",
  login: "bg-primary/20 text-primary border-primary/30",
  login_failed: "bg-amber-500/20 text-amber-600 border-amber-500/30",
  logout: "bg-muted text-muted-foreground",
  user_created: "bg-emerald-500/20 text-emerald-600 border-emerald-500/30",
  user_deleted: "bg-destructive/20 text-destructive border-destructive/30",
  user_updated: "bg-blue-500/20 text-blue-600 border-blue-500/30",
};

const TYPE_LABEL: Record<string, string> = {
  auth: "Autenticação",
  data: "Dados",
  business: "Negócio",
};

export default function AdminAuditoria() {
  const { isAdmin, loading: authLoading } = useAuth();
  const [filters, setFilters] = useState({
    user_email: "",
    action: "",
    table_name: "",
    action_type: "all",
    record_id: "",
    from: "",
    to: "",
  });
  const [appliedFilters, setAppliedFilters] = useState(filters);
  const [selected, setSelected] = useState<any | null>(null);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["audit-trail", appliedFilters],
    queryFn: async () => {
      let q = supabase
        .from("audit_trail")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(500);

      if (appliedFilters.user_email) q = q.ilike("user_email", `%${appliedFilters.user_email}%`);
      if (appliedFilters.action) q = q.ilike("action", `%${appliedFilters.action}%`);
      if (appliedFilters.table_name) q = q.ilike("table_name", `%${appliedFilters.table_name}%`);
      if (appliedFilters.record_id) q = q.eq("record_id", appliedFilters.record_id);
      if (appliedFilters.action_type !== "all") q = q.eq("action_type", appliedFilters.action_type);
      if (appliedFilters.from) q = q.gte("created_at", appliedFilters.from);
      if (appliedFilters.to) q = q.lte("created_at", appliedFilters.to);

      const { data, error } = await q;
      if (error) throw error;
      return data ?? [];
    },
    enabled: isAdmin,
  });

  if (authLoading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Shield className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Auditoria do Sistema</h1>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-2 ${isFetching ? "animate-spin" : ""}`} />
          Atualizar
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Filtros</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Tipo</Label>
              <Select value={filters.action_type} onValueChange={(v) => setFilters({ ...filters, action_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos</SelectItem>
                  <SelectItem value="auth">Autenticação</SelectItem>
                  <SelectItem value="data">Dados</SelectItem>
                  <SelectItem value="business">Negócio</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Email do usuário</Label>
              <Input value={filters.user_email} onChange={(e) => setFilters({ ...filters, user_email: e.target.value })} placeholder="ex: filipe" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Ação</Label>
              <Input value={filters.action} onChange={(e) => setFilters({ ...filters, action: e.target.value })} placeholder="ex: DELETE" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Tabela</Label>
              <Input value={filters.table_name} onChange={(e) => setFilters({ ...filters, table_name: e.target.value })} placeholder="ex: user_roles" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">ID do registro</Label>
              <Input value={filters.record_id} onChange={(e) => setFilters({ ...filters, record_id: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">De</Label>
              <Input type="datetime-local" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Até</Label>
              <Input type="datetime-local" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} />
            </div>
          </div>
          <div className="flex gap-2 mt-3">
            <Button onClick={() => setAppliedFilters(filters)} size="sm">
              <Search className="h-4 w-4 mr-2" /> Buscar
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                const empty = { user_email: "", action: "", table_name: "", action_type: "all", record_id: "", from: "", to: "" };
                setFilters(empty); setAppliedFilters(empty);
              }}
            >
              Limpar
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">
            Eventos {data && <span className="text-xs text-muted-foreground ml-2">({data.length} registros, máx 500)</span>}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : !data?.length ? (
            <div className="text-center p-8 text-sm text-muted-foreground">Nenhum evento encontrado.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Data/Hora</TableHead>
                  <TableHead>Usuário</TableHead>
                  <TableHead>Tipo</TableHead>
                  <TableHead>Ação</TableHead>
                  <TableHead>Tabela / Entidade</TableHead>
                  <TableHead>Registro ID</TableHead>
                  <TableHead className="text-right">Detalhes</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.map((e: any) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs whitespace-nowrap">
                      {new Date(e.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div>{e.user_email ?? <span className="text-muted-foreground">sistema</span>}</div>
                      {e.user_role && <div className="text-xs text-muted-foreground">{e.user_role}</div>}
                    </TableCell>
                    <TableCell><Badge variant="outline">{TYPE_LABEL[e.action_type] ?? e.action_type}</Badge></TableCell>
                    <TableCell>
                      <Badge variant="secondary" className={ACTION_COLOR[e.action] ?? ""}>{e.action}</Badge>
                    </TableCell>
                    <TableCell className="text-xs font-mono">{e.table_name ?? "—"}</TableCell>
                    <TableCell className="text-xs font-mono truncate max-w-[180px]">{e.record_id ?? "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSelected(e)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Detalhes do evento #{selected?.id}</DialogTitle>
          </DialogHeader>
          {selected && (
            <ScrollArea className="max-h-[60vh]">
              <div className="space-y-4 text-sm pr-3">
                <div className="grid grid-cols-2 gap-3">
                  <div><span className="text-muted-foreground">Usuário:</span> {selected.user_email ?? "sistema"}</div>
                  <div><span className="text-muted-foreground">Perfil:</span> {selected.user_role ?? "—"}</div>
                  <div><span className="text-muted-foreground">Tipo:</span> {TYPE_LABEL[selected.action_type] ?? selected.action_type}</div>
                  <div><span className="text-muted-foreground">Ação:</span> {selected.action}</div>
                  <div><span className="text-muted-foreground">Tabela:</span> {selected.table_name ?? "—"}</div>
                  <div><span className="text-muted-foreground">Registro:</span> {selected.record_id ?? "—"}</div>
                  <div className="col-span-2"><span className="text-muted-foreground">Data:</span> {new Date(selected.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}</div>
                </div>

                {selected.diff && (
                  <div>
                    <div className="font-semibold mb-1">Campos alterados</div>
                    <pre className="text-xs bg-muted/30 rounded p-2 overflow-auto">{JSON.stringify(selected.diff, null, 2)}</pre>
                  </div>
                )}
                {selected.before_data && (
                  <div>
                    <div className="font-semibold mb-1">Antes</div>
                    <pre className="text-xs bg-muted/30 rounded p-2 overflow-auto">{JSON.stringify(selected.before_data, null, 2)}</pre>
                  </div>
                )}
                {selected.after_data && (
                  <div>
                    <div className="font-semibold mb-1">Depois</div>
                    <pre className="text-xs bg-muted/30 rounded p-2 overflow-auto">{JSON.stringify(selected.after_data, null, 2)}</pre>
                  </div>
                )}
                {selected.context && (
                  <div>
                    <div className="font-semibold mb-1">Contexto</div>
                    <pre className="text-xs bg-muted/30 rounded p-2 overflow-auto">{JSON.stringify(selected.context, null, 2)}</pre>
                  </div>
                )}
              </div>
            </ScrollArea>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
