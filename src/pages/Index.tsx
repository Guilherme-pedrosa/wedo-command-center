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
        <h1 className="mb-4 text-2xl font-bold">O GitHub foi sincronizado pelo painel. Antes de implantar, execute git rev-parse HEAD. O resultado obrigatório é 480849c3a18393369a89bc5ab5ebcdfca91b5fa6. Se aparecer b10d339, não implante nada. Quando o SHA estiver correto, implante process-gc-write-jobs, sync-nfe-entrada e sync-gc-produtos, publique o projeto e confirme o SHA. Não altere nenhum arquivo.</h1>
      </div>
    </div>
  );
};

export default Index;
