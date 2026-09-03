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
        <h1 className="mb-4 text-2xl font-bold">Redirecionando…</h1>
      </div>
    </div>
  );
};

export default Index;
