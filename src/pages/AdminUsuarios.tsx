import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Plus, Shield, User, Users, Pencil, Trash2, Crown } from "lucide-react";
import toast from "react-hot-toast";
import { Navigate } from "react-router-dom";

type RoleKey = "admin" | "ceo" | "gerente_comercial" | "gerente_financeiro" | "vendedor" | "user";

const ROLE_OPTIONS: { value: RoleKey; label: string; hint: string }[] = [
  { value: "admin", label: "Administrador", hint: "Acesso total ao sistema" },
  { value: "ceo", label: "CEO", hint: "Aprova margens e políticas" },
  { value: "gerente_financeiro", label: "Gerente Financeiro", hint: "Vê custos e tributos" },
  { value: "gerente_comercial", label: "Gerente Comercial", hint: "Vê preços e margens" },
  { value: "vendedor", label: "Vendedor", hint: "Apenas consulta de preços" },
  { value: "user", label: "Usuário", hint: "Acesso básico" },
];

const ROLE_BADGE: Record<string, { label: string; icon: any; className: string }> = {
  admin: { label: "Admin", icon: Shield, className: "bg-wedo-orange/20 text-wedo-orange border-wedo-orange/30" },
  ceo: { label: "CEO", icon: Crown, className: "bg-amber-500/20 text-amber-600 border-amber-500/30" },
  gerente_financeiro: { label: "Ger. Financeiro", icon: Shield, className: "bg-emerald-500/20 text-emerald-600 border-emerald-500/30" },
  gerente_comercial: { label: "Ger. Comercial", icon: Shield, className: "bg-blue-500/20 text-blue-600 border-blue-500/30" },
  vendedor: { label: "Vendedor", icon: User, className: "bg-violet-500/20 text-violet-600 border-violet-500/30" },
  user: { label: "Usuário", icon: User, className: "" },
};

const emptyForm = {
  email: "",
  password: "",
  nome: "",
  gc_codigo: "",
  auvo_codigo: "",
  roles: ["user"] as RoleKey[],
};

const RolesPicker = ({ value, onChange }: { value: RoleKey[]; onChange: (v: RoleKey[]) => void }) => {
  const toggle = (r: RoleKey, checked: boolean) => {
    const set = new Set(value);
    if (checked) set.add(r); else set.delete(r);
    onChange(Array.from(set) as RoleKey[]);
  };
  return (
    <div className="space-y-2">
      <Label>Perfis (selecione um ou mais)</Label>
      <div className="grid grid-cols-2 gap-2 rounded-md border border-border p-3">
        {ROLE_OPTIONS.map((opt) => (
          <label key={opt.value} className="flex items-start gap-2 cursor-pointer text-sm">
            <Checkbox
              checked={value.includes(opt.value)}
              onCheckedChange={(c) => toggle(opt.value, !!c)}
            />
            <div className="leading-tight">
              <div className="font-medium">{opt.label}</div>
              <div className="text-xs text-muted-foreground">{opt.hint}</div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
};

const UserFormFields = ({ values, onChange, showEmail = false, showPassword = true, passwordRequired = false }: any) => (
  <>
    <div className="space-y-2">
      <Label>Nome *</Label>
      <Input value={values.nome} onChange={(e) => onChange({ ...values, nome: e.target.value })} required />
    </div>
    {showEmail && (
      <div className="space-y-2">
        <Label>Email *</Label>
        <Input type="email" value={values.email} onChange={(e) => onChange({ ...values, email: e.target.value })} required />
      </div>
    )}
    {showPassword && (
      <div className="space-y-2">
        <Label>{passwordRequired ? "Senha *" : "Nova Senha (deixe vazio para manter)"}</Label>
        <Input type="password" value={values.password} onChange={(e) => onChange({ ...values, password: e.target.value })} {...(passwordRequired ? { required: true, minLength: 6 } : {})} />
      </div>
    )}
    <div className="grid grid-cols-2 gap-4">
      <div className="space-y-2">
        <Label>Código GC</Label>
        <Input value={values.gc_codigo} onChange={(e) => onChange({ ...values, gc_codigo: e.target.value })} />
      </div>
      <div className="space-y-2">
        <Label>Código AUVO</Label>
        <Input value={values.auvo_codigo} onChange={(e) => onChange({ ...values, auvo_codigo: e.target.value })} />
      </div>
    </div>
    <RolesPicker value={values.roles ?? []} onChange={(r) => onChange({ ...values, roles: r })} />
  </>
);

export default function AdminUsuarios() {
  const { isAdmin, user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState<any>({ id: "", nome: "", gc_codigo: "", auvo_codigo: "", roles: ["user"] as RoleKey[], password: "" });

  const { data: users, isLoading } = useQuery({
    queryKey: ["admin-users"],
    queryFn: async () => {
      const { data: profiles } = await supabase.from("profiles").select("*").order("created_at", { ascending: false });
      const { data: roles } = await supabase.from("user_roles").select("*");
      return (profiles ?? []).map((p: any) => ({
        ...p,
        roles: (roles ?? []).filter((r: any) => r.user_id === p.id).map((r: any) => r.role),
      }));
    },
    enabled: isAdmin,
  });

  const createUser = useMutation({
    mutationFn: async (data: typeof form) => {
      const { data: result, error } = await supabase.functions.invoke("admin-create-user", { body: data });
      if (error) throw new Error(error.message);
      if (result?.error) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast.success("Usuário criado!");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setCreateOpen(false);
      setForm(emptyForm);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateUser = useMutation({
    mutationFn: async (data: any) => {
      const { data: result, error } = await supabase.functions.invoke("admin-manage-user", {
        body: { action: "update", user_id: data.id, nome: data.nome, gc_codigo: data.gc_codigo, auvo_codigo: data.auvo_codigo, roles: data.roles, password: data.password || undefined },
      });
      if (error) throw new Error(error.message);
      if (result?.error) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast.success("Usuário atualizado!");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      setEditOpen(false);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteUser = useMutation({
    mutationFn: async (userId: string) => {
      const { data: result, error } = await supabase.functions.invoke("admin-manage-user", {
        body: { action: "delete", user_id: userId },
      });
      if (error) throw new Error(error.message);
      if (result?.error) throw new Error(result.error);
      return result;
    },
    onSuccess: () => {
      toast.success("Usuário removido!");
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const openEdit = (u: any) => {
    setEditForm({
      id: u.id,
      nome: u.nome,
      gc_codigo: u.gc_codigo || "",
      auvo_codigo: u.auvo_codigo || "",
      roles: (u.roles?.length ? u.roles : ["user"]) as RoleKey[],
      password: "",
    });
    setEditOpen(true);
  };

  if (authLoading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!isAdmin) return <Navigate to="/" replace />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Users className="h-6 w-6 text-primary" />
          <h1 className="text-2xl font-bold text-foreground">Gerenciar Usuários</h1>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 mr-2" /> Novo Usuário</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Criar Novo Usuário</DialogTitle>
              <DialogDescription>Preencha os dados do novo usuário.</DialogDescription>
            </DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); createUser.mutate(form); }} className="space-y-4">
              <UserFormFields values={form} onChange={setForm} showEmail showPassword passwordRequired />
              <Button type="submit" className="w-full" disabled={createUser.isPending}>
                {createUser.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Criar Usuário
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar Usuário</DialogTitle>
            <DialogDescription>Altere os dados do usuário.</DialogDescription>
          </DialogHeader>
          <form onSubmit={(e) => { e.preventDefault(); updateUser.mutate(editForm); }} className="space-y-4">
            <UserFormFields values={editForm} onChange={setEditForm} />
            <Button type="submit" className="w-full" disabled={updateUser.isPending}>
              {updateUser.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Salvar Alterações
            </Button>
          </form>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Usuários Cadastrados</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex justify-center p-4"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Nome</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Código GC</TableHead>
                  <TableHead>Código AUVO</TableHead>
                  <TableHead>Perfis</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users?.map((u: any) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.nome}</TableCell>
                    <TableCell>{u.email}</TableCell>
                    <TableCell>{u.gc_codigo || "—"}</TableCell>
                    <TableCell>{u.auvo_codigo || "—"}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {(u.roles ?? []).length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          (u.roles as string[]).map((r) => {
                            const cfg = ROLE_BADGE[r] ?? { label: r, icon: User, className: "" };
                            const Icon = cfg.icon;
                            return (
                              <Badge key={r} variant="secondary" className={cfg.className}>
                                <Icon className="h-3 w-3 mr-1" /> {cfg.label}
                              </Badge>
                            );
                          })
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(u)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {u.id !== user?.id && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive">
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </AlertDialogTrigger>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Remover usuário?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  Tem certeza que deseja remover <strong>{u.nome}</strong> ({u.email})? Esta ação não pode ser desfeita.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Cancelar</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => deleteUser.mutate(u.id)}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                >
                                  Remover
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
