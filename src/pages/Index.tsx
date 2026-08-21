import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const Index = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/financeiro/precificacao");
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-8">
      <div className="text-center max-w-2xl">
        <h1 className="mb-4 text-2xl font-bold">Carregando...</h1>
        <div className="text-sm text-muted-foreground whitespace-pre-wrap text-left border rounded p-4 bg-secondary/20">
          corrija este erro:

Erro ao agendar correção: new row violates row-level security policy (USING expression) for table "fin_gc_write_jobs"
        </div>
      </div>
    </div>
  );
};

export default Index;
