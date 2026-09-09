const preservedFields = ["data_vencimento", "data_competencia", "valor", "plano_contas_id", "forma_pagamento_id", "conta_bancaria_id", "cliente_id", "entidade", "centro_custo_id", "juros", "multa", "desconto", "taxa_banco", "taxa_operadora", "funcionario_id", "transportadora_id", "rateios"];
type Receipt = Record<string, any>;
const attribute = (a: Receipt) => a.atributo || a;
const attributeId = (a: Receipt) => String(attribute(a).atributo_id ?? attribute(a).id);
const attributeValue = (a: Receipt) => String(attribute(a).valor ?? attribute(a).conteudo ?? "");

/** Dedicated invoice annotation: callers cannot provide any financial field. */
export function buildReceivableNfsePayload(fresh: Receipt, request: Receipt) {
  if (!request || Object.keys(request).some(key => key !== "nfse_numero") || !/^\d{1,20}$/.test(String(request.nfse_numero ?? ""))) {
    throw new Error("Vinculação de NFS-e aceita somente o número da nota, sem alterações financeiras.");
  }
  if (!fresh.id || !["0", "1", 0, 1, false, true].includes(fresh.liquidado)) throw new Error("Situação do título não confirmada.");
  const number = String(request.nfse_numero);
  const original = String(fresh.descricao ?? "");
  const tagged = new RegExp(`\\bNF\\s*${number}\\b`, "i").test(original);
  const payload: Receipt = { descricao: tagged ? original : `NF${number} ${original}`.trim() };
  for (const key of preservedFields) if (fresh[key] !== undefined && fresh[key] !== null) payload[key] = fresh[key];
  payload.valor ??= fresh.valor_total;
  for (const key of ["data_vencimento", "data_competencia", "plano_contas_id", "forma_pagamento_id", "conta_bancaria_id", "cliente_id"]) {
    if (!payload[key]) throw new Error(`Título sem ${key}; vinculação interrompida.`);
  }
  if (!Number.isFinite(Number(payload.valor)) || Number(payload.valor) < 0) throw new Error("Valor atual inválido.");
  if (fresh.atributos != null && !Array.isArray(fresh.atributos)) throw new Error("Campos extras não puderam ser preservados.");
  payload.atributos = (fresh.atributos || []).filter((a: Receipt) => attributeId(a) !== "8928").map((a: Receipt) => {
    if (!/^\d+$/.test(attributeId(a))) throw new Error("Identidade de campo extra desconhecida.");
    return { atributo: { atributo_id: attributeId(a), conteudo: attributeValue(a) } };
  });
  payload.atributos.push({ atributo: { atributo_id: "8928", conteudo: number } });
  return payload;
}

/** Successful HTTP is insufficient: confirm the annotation and unchanged finance. */
export function assertReceivableNfseConfirmed(before: Receipt, after: Receipt, payload: Receipt) {
  for (const key of ["id", "cliente_id", "data_vencimento", "data_competencia", "plano_contas_id", "forma_pagamento_id", "conta_bancaria_id"]) {
    if (String(before[key] ?? "") !== String(after[key] ?? "")) throw new Error(`GC alterou ${key} durante vinculação da NFS-e.`);
  }
  for (const key of ["data_liquidacao", "liquidacao", "entidade", "centro_custo_id", "funcionario_id", "transportadora_id"]) {
    if (before[key] != null && String(before[key]) !== String(after[key] ?? "")) throw new Error(`GC alterou ${key} durante vinculação da NFS-e.`);
  }
  for (const key of ["valor", "valor_total", "juros", "multa", "desconto", "taxa_banco", "taxa_operadora"]) {
    if (before[key] != null && (!Number.isFinite(Number(after[key])) || Math.round(Number(before[key]) * 100) !== Math.round(Number(after[key]) * 100))) {
      throw new Error(`GC não preservou ${key} durante vinculação da NFS-e.`);
    }
  }
  const paid = (r: Receipt) => ["1", 1, true].includes(r.liquidado);
  if (!["0", "1", 0, 1, false, true].includes(after.liquidado) || paid(before) !== paid(after)) throw new Error("Quitação mudou durante vinculação da NFS-e.");
  if (after.descricao !== payload.descricao || !Array.isArray(after.atributos) || payload.atributos.some((expected: Receipt) =>
    !after.atributos.some((actual: Receipt) => attributeId(actual) === attributeId(expected) && attributeValue(actual) === attributeValue(expected)))) {
    throw new Error("GC não confirmou a descrição e os campos extras da NFS-e.");
  }
}
