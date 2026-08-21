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
          {"PARA ALTERAR A PORRA DO NCM DO PRODUTO, SIGA ESTE PASSO A PASSO:\n\nPara alterar o NCM dos equipamentos via API, o Lovable deve utilizar o endpoint de edição de produtos.  Método: PUT  Endpoint: [https://api.gestaoclick.com/produtos/](https://api.gestaoclick.com/produtos/){id} (onde {id} é o identificador do equipamento).  Formato: JSON (application/json)."}
        </p>
      </div>
    </div>
  );
};

export default Index;
