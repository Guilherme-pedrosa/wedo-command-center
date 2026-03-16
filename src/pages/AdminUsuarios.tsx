import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogDescription } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Plus, Shield, User, Users, Pencil, Trash2 } from "lucide-react";
import toast from "react-hot-toast";
import { Navigate } from "react-router-dom";

const emptyForm = { email: "", password: "", nome: "", gc_codigo: "", auvo_codigo: "", role: "user" };

export default function AdminUsuarios() {
  const { isAdmin, user, loading: authLoading } = useAuth();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [editForm, setEditForm] = useState<any>({ id: "", nome: "", gc_codigo: "", auvo_codigo: "", role: "user", password: "" });

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
        body: { action: "update", user_id: data.id, nome: data.nome, gc_codigo: data.gc_codigo, auvo_codigo: data.auvo_codigo, role: data.role, password: data.password || undefined },
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
      role: u.roles?.includes("admin") ? "admin" : "user",
      password: "",
    });
    setEditOpen(true);
  };

  if (authLoading) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!isAdmin) return <Navigate to="/" replace />;

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
      <div className="space-y-2">
        <Label>Perfil</Label>
        <Select value={values.role} onValueChange={(v) => onChange({ ...values, role: v })}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="user">Usuário</SelectItem>
            <SelectItem value="admin">Administrador</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </>
  );

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
                  <TableHead>Perfil</TableHead>
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
                      {u.roles?.includes("admin") ? (
                        <Badge className="bg-wedo-orange/20 text-wedo-orange border-wedo-orange/30">
                          <Shield className="h-3 w-3 mr-1" /> Admin
                        </Badge>
                      ) : (
                        <Badge variant="secondary">
                          <User className="h-3 w-3 mr-1" /> Usuário
                        </Badge>
                      )}
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
