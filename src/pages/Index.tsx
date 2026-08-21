import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

const Index = () => {
  const navigate = useNavigate();
  useEffect(() => {
    navigate("/financeiro/precificacao");
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center">
        <h1 className="mb-4 text-4xl font-bold">Carregando...</h1>
        <p className="text-xl text-muted-foreground whitespace-pre-wrap text-center max-w-2xl px-4">
          {"DESGRAÇADO, NÃO É PRA ALTERAR TEXTO, É PRA ALTERAR O SISTEMA"}
        </p>
      </div>
    </div>
  );
};

export default Index;
