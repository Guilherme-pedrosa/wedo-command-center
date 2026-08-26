import { describe, it, expect } from "vitest";
import {
  parseXmlItems,
  getXmlFrete,
  getXmlMeta,
  getXmlCrt,
  getXmlEmitente,
  getXmlTotais,
  getXmlIde,
  temCsosn,
  isXmlSimplesNacional,
} from "../../supabase/functions/_shared/nfeXmlParser";

/**
 * Fixture com os casos que quebram parser ingênuo:
 *  item 1 — PISAliq/COFINSAliq + ICMS00 com pRedBC e IPITrib
 *  item 2 — PISNT/COFINSNT (CST 07 mora na subtag, não no bloco externo)
 *  item 3 — ICMS ST + FCP-ST + DIFAL, PISOutr CST 99
 */
const XML_REGIME_NORMAL = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
 <NFe><infNFe Id="NFe35240912345678000199550010000012341000012345" versao="4.00">
  <ide><cUF>35</cUF><nNF>1234</nNF><serie>1</serie><mod>55</mod>
    <dhEmi>2026-07-15T10:30:00-03:00</dhEmi><natOp>Venda de mercadoria</natOp></ide>
  <emit><CNPJ>12345678000199</CNPJ><xNome>Fornecedor Regime Normal LTDA</xNome>
    <enderEmit><UF>SP</UF></enderEmit><CRT>3</CRT></emit>
  <det nItem="1">
    <prod><cProd>P001</cProd><xProd>Peca A</xProd><NCM>84819090</NCM><CFOP>1102</CFOP>
      <uCom>UN</uCom><qCom>10.0000</qCom><vUnCom>100.00</vUnCom><vProd>1000.00</vProd>
      <vFrete>50.00</vFrete><vDesc>0.00</vDesc></prod>
    <imposto>
      <ICMS><ICMS00><orig>0</orig><CST>00</CST><pRedBC>20.00</pRedBC>
        <vBC>800.00</vBC><pICMS>18.00</pICMS><vICMS>144.00</vICMS></ICMS00></ICMS>
      <IPI><IPITrib><CST>50</CST><vBC>1000.00</vBC><pIPI>5.00</pIPI><vIPI>50.00</vIPI></IPITrib></IPI>
      <PIS><PISAliq><CST>01</CST><vBC>1000.00</vBC><pPIS>1.65</pPIS><vPIS>16.50</vPIS></PISAliq></PIS>
      <COFINS><COFINSAliq><CST>01</CST><vBC>1000.00</vBC><pCOFINS>7.60</pCOFINS><vCOFINS>76.00</vCOFINS></COFINSAliq></COFINS>
    </imposto>
  </det>
  <det nItem="2">
    <prod><cProd>P002</cProd><xProd>Peca B</xProd><NCM>85049090</NCM><CFOP>1102</CFOP>
      <uCom>UN</uCom><qCom>5.0000</qCom><vUnCom>40.00</vUnCom><vProd>200.00</vProd>
      <vFrete>0.00</vFrete><vDesc>10.00</vDesc></prod>
    <imposto>
      <ICMS><ICMS40><orig>1</orig><CST>40</CST></ICMS40></ICMS>
      <PIS><PISNT><CST>07</CST></PISNT></PIS>
      <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
    </imposto>
  </det>
  <det nItem="3">
    <prod><cProd>P003</cProd><xProd>Peca C</xProd><NCM>87089990</NCM><CFOP>1403</CFOP>
      <uCom>UN</uCom><qCom>2.0000</qCom><vUnCom>150.00</vUnCom><vProd>300.00</vProd></prod>
    <imposto>
      <ICMS><ICMS10><orig>0</orig><CST>10</CST><vBC>300.00</vBC><pICMS>18.00</pICMS>
        <vICMS>54.00</vICMS><vICMSST>72.00</vICMSST><vFCPST>6.00</vFCPST></ICMS10></ICMS>
      <ICMSUFDest><vICMSUFDest>12.00</vICMSUFDest><vICMSUFRemet>3.00</vICMSUFRemet></ICMSUFDest>
      <PIS><PISOutr><CST>99</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>
      <COFINS><COFINSOutr><CST>99</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
    </imposto>
  </det>
  <total><ICMSTot><vProd>1500.00</vProd><vFrete>50.00</vFrete><vDesc>10.00</vDesc>
    <vIPI>50.00</vIPI><vICMS>198.00</vICMS><vST>72.00</vST><vNF>1662.00</vNF></ICMSTot></total>
 </infNFe></NFe>
</nfeProc>`;

/** Fornecedor do Simples: CSOSN em vez de CST, sem tributo destacado. */
const XML_SIMPLES = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
 <NFe><infNFe Id="NFe35240998765432000188550010000099991000099999" versao="4.00">
  <ide><nNF>9999</nNF><serie>1</serie><mod>55</mod><dhEmi>2026-07-20T09:00:00-03:00</dhEmi>
    <natOp>Venda</natOp></ide>
  <emit><CNPJ>98765432000188</CNPJ><xNome>Fornecedor Simples ME</xNome>
    <enderEmit><UF>MG</UF></enderEmit><CRT>1</CRT></emit>
  <det nItem="1">
    <prod><cProd>S001</cProd><xProd>Insumo D</xProd><NCM>39269090</NCM><CFOP>2102</CFOP>
      <uCom>UN</uCom><qCom>4.0000</qCom><vUnCom>125.00</vUnCom><vProd>500.00</vProd></prod>
    <imposto>
      <ICMS><ICMSSN102><orig>0</orig><CSOSN>102</CSOSN></ICMSSN102></ICMS>
      <PIS><PISOutr><CST>49</CST><vBC>0.00</vBC><pPIS>0.00</pPIS><vPIS>0.00</vPIS></PISOutr></PIS>
      <COFINS><COFINSOutr><CST>49</CST><vBC>0.00</vBC><pCOFINS>0.00</pCOFINS><vCOFINS>0.00</vCOFINS></COFINSOutr></COFINS>
    </imposto>
  </det>
  <total><ICMSTot><vProd>500.00</vProd><vFrete>0.00</vFrete><vDesc>0.00</vDesc>
    <vIPI>0.00</vIPI><vICMS>0.00</vICMS><vST>0.00</vST><vNF>500.00</vNF></ICMSTot></total>
 </infNFe></NFe>
</nfeProc>`;

describe("parseXmlItems — layout real da NF-e", () => {
  const itens = parseXmlItems(XML_REGIME_NORMAL);

  it("lê todos os itens preservando nItem", () => {
    expect(itens).toHaveLength(3);
    expect(itens.map((i) => i.nItem)).toEqual([1, 2, 3]);
  });

  it("extrai identificação e valores do produto", () => {
    const [i1] = itens;
    expect(i1.cProd).toBe("P001");
    expect(i1.NCM).toBe("84819090");
    expect(i1.CFOP).toBe("1102");
    expect(i1.qCom).toBe(10);
    expect(i1.vProd).toBe(1000);
  });

  it("lê CST de PIS/COFINS dentro da subtag PISAliq", () => {
    expect(itens[0].pis_cst).toBe("01");
    expect(itens[0].pis_pPIS).toBe(1.65);
    expect(itens[0].pis_vPIS).toBe(16.5);
    expect(itens[0].cofins_cst).toBe("01");
  });

  it("lê CST 07 de PISNT/COFINSNT — o caso que parser ingênuo erra", () => {
    expect(itens[1].pis_cst).toBe("07");
    expect(itens[1].cofins_cst).toBe("07");
    expect(itens[1].pis_vPIS).toBe(0);
  });

  it("lê CST 99 de PISOutr", () => {
    expect(itens[2].pis_cst).toBe("99");
    expect(itens[2].cofins_cst).toBe("99");
  });

  it("captura redução de base do ICMS", () => {
    expect(itens[0].icms_cst).toBe("00");
    expect(itens[0].icms_pRedBC).toBe(20);
    expect(itens[0].icms_vBC).toBe(800);
    expect(itens[0].icms_vICMS).toBe(144);
  });

  it("captura ICMS-ST e FCP-ST", () => {
    expect(itens[2].icms_vICMSST).toBe(72);
    expect(itens[2].icms_vFCPST).toBe(6);
  });

  it("captura DIFAL (ICMSUFDest)", () => {
    expect(itens[2].icms_vICMSUFDest).toBe(12);
    expect(itens[2].icms_vICMSUFRemet).toBe(3);
  });

  it("captura IPI de IPITrib", () => {
    expect(itens[0].ipi_cst).toBe("50");
    expect(itens[0].ipi_vIPI).toBe(50);
  });

  it("item sem tributação não inventa valores", () => {
    expect(itens[1].icms_cst).toBe("40");
    expect(itens[1].icms_vICMS).toBe(0);
    expect(itens[1].vDesc).toBe(10);
  });
});

describe("cabeçalho da NF-e", () => {
  it("lê chave, número e natureza", () => {
    const meta = getXmlMeta(XML_REGIME_NORMAL);
    expect(meta.chave).toBe("35240912345678000199550010000012341000012345");
    expect(meta.numero_nf).toBe("1234");
    expect(meta.data_emissao).toBe("2026-07-15");
    expect(meta.nat_op).toBe("Venda de mercadoria");
  });

  it("lê o bloco ide", () => {
    const ide = getXmlIde(XML_REGIME_NORMAL);
    expect(ide).toEqual({ modelo: "55", numero: "1234", serie: "1", dataEmissao: "2026-07-15" });
  });

  it("lê frete do total", () => {
    expect(getXmlFrete(XML_REGIME_NORMAL)).toBe(50);
  });

  it("lê os totais da nota", () => {
    const t = getXmlTotais(XML_REGIME_NORMAL);
    expect(t.vProd).toBe(1500);
    expect(t.vICMS).toBe(198);
    expect(t.vST).toBe(72);
    expect(t.vNF).toBe(1662);
  });

  it("lê emitente com UF e CRT", () => {
    const e = getXmlEmitente(XML_REGIME_NORMAL);
    expect(e.cnpj).toBe("12345678000199");
    expect(e.uf).toBe("SP");
    expect(e.crt).toBe(3);
  });
});

describe("regime do emitente", () => {
  it("getXmlCrt devolve o CRT literal, sem heurística", () => {
    expect(getXmlCrt(XML_REGIME_NORMAL)).toBe(3);
    expect(getXmlCrt(XML_SIMPLES)).toBe(1);
  });

  it("getXmlCrt devolve null quando a tag não existe", () => {
    expect(getXmlCrt("<emit><xNome>Sem CRT</xNome></emit>")).toBeNull();
  });

  it("detecta CSOSN como corroboração de Simples", () => {
    expect(temCsosn(parseXmlItems(XML_SIMPLES))).toBe(true);
    expect(temCsosn(parseXmlItems(XML_REGIME_NORMAL))).toBe(false);
  });

  it("XML do Simples: CSOSN no lugar do CST de ICMS", () => {
    const [item] = parseXmlItems(XML_SIMPLES);
    expect(item.icms_cst).toBe("102");
    expect(item.pis_cst).toBe("49");
    expect(item.CFOP).toBe("2102");
    expect(item.vProd).toBe(500);
  });

  it("isXmlSimplesNacional (precificação) concorda nos casos limpos", () => {
    expect(isXmlSimplesNacional(XML_SIMPLES, parseXmlItems(XML_SIMPLES))).toBe(true);
    expect(isXmlSimplesNacional(XML_REGIME_NORMAL, parseXmlItems(XML_REGIME_NORMAL))).toBe(false);
  });
});
