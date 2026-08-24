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
        <h1 className="mb-4 text-2xl font-bold">mude apenas o NCM no gestão click (precificação) você não está mudando nada!!!</h1>
      </div>
    </div>
  );
};

export default Index;
