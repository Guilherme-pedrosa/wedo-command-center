export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      configuracoes: {
        Row: {
          chave: string
          updated_at: string | null
          valor: string | null
        }
        Insert: {
          chave: string
          updated_at?: string | null
          valor?: string | null
        }
        Update: {
          chave?: string
          updated_at?: string | null
          valor?: string | null
        }
        Relationships: []
      }
      fin_agenda_pagamentos: {
        Row: {
          centro_custo_id: string | null
          chave_pix_destino: string | null
          conta_bancaria_id: string | null
          created_at: string | null
          created_by: string | null
          data_vencimento: string
          descricao: string
          executado_em: string | null
          fornecedor_gc_id: string | null
          gc_baixado: boolean | null
          gc_pagamento_id: string | null
          id: string
          inter_pagamento_id: string | null
          nome_fornecedor: string | null
          observacao: string | null
          plano_contas_id: string | null
          recorrencia: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id: string | null
          status: string | null
          tipo_chave: string | null
          ultimo_erro: string | null
          updated_at: string | null
          valor: number
        }
        Insert: {
          centro_custo_id?: string | null
          chave_pix_destino?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_vencimento: string
          descricao: string
          executado_em?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_pagamento_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          plano_contas_id?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: string | null
          tipo_chave?: string | null
          ultimo_erro?: string | null
          updated_at?: string | null
          valor: number
        }
        Update: {
          centro_custo_id?: string | null
          chave_pix_destino?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_vencimento?: string
          descricao?: string
          executado_em?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_pagamento_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          plano_contas_id?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: string | null
          tipo_chave?: string | null
          ultimo_erro?: string | null
          updated_at?: string | null
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_agenda_pagamentos_centro_custo_id_fkey"
            columns: ["centro_custo_id"]
            isOneToOne: false
            referencedRelation: "fin_centros_custo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_agenda_pagamentos_conta_bancaria_id_fkey"
            columns: ["conta_bancaria_id"]
            isOneToOne: false
            referencedRelation: "fin_contas_bancarias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_agenda_pagamentos_gc_pagamento_id_fkey"
            columns: ["gc_pagamento_id"]
            isOneToOne: false
            referencedRelation: "fin_pagamentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_agenda_pagamentos_plano_contas_id_fkey"
            columns: ["plano_contas_id"]
            isOneToOne: false
            referencedRelation: "fin_plano_contas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_agenda_pagamentos_recorrencia_pai_id_fkey"
            columns: ["recorrencia_pai_id"]
            isOneToOne: false
            referencedRelation: "fin_agenda_pagamentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_centros_custo: {
        Row: {
          ativo: boolean | null
          codigo: string | null
          created_at: string | null
          id: string
          nome: string
        }
        Insert: {
          ativo?: boolean | null
          codigo?: string | null
          created_at?: string | null
          id?: string
          nome: string
        }
        Update: {
          ativo?: boolean | null
          codigo?: string | null
          created_at?: string | null
          id?: string
          nome?: string
        }
        Relationships: []
      }
      fin_clientes: {
        Row: {
          bairro: string | null
          cep: string | null
          cidade: string | null
          cpf_cnpj: string | null
          data_cadastro: string | null
          email: string | null
          endereco: string | null
          estado: string | null
          gc_id: string
          id: string
          last_synced: string | null
          nome: string
          nome_fantasia: string | null
          observacao: string | null
          payload_raw: Json | null
          razao_social: string | null
          telefone: string | null
          tipo_pessoa: string | null
        }
        Insert: {
          bairro?: string | null
          cep?: string | null
          cidade?: string | null
          cpf_cnpj?: string | null
          data_cadastro?: string | null
          email?: string | null
          endereco?: string | null
          estado?: string | null
          gc_id: string
          id?: string
          last_synced?: string | null
          nome: string
          nome_fantasia?: string | null
          observacao?: string | null
          payload_raw?: Json | null
          razao_social?: string | null
          telefone?: string | null
          tipo_pessoa?: string | null
        }
        Update: {
          bairro?: string | null
          cep?: string | null
          cidade?: string | null
          cpf_cnpj?: string | null
          data_cadastro?: string | null
          email?: string | null
          endereco?: string | null
          estado?: string | null
          gc_id?: string
          id?: string
          last_synced?: string | null
          nome?: string
          nome_fantasia?: string | null
          observacao?: string | null
          payload_raw?: Json | null
          razao_social?: string | null
          telefone?: string | null
          tipo_pessoa?: string | null
        }
        Relationships: []
      }
      fin_configuracoes: {
        Row: {
          chave: string
          descricao: string | null
          id: string
          updated_at: string | null
          valor: string | null
        }
        Insert: {
          chave: string
          descricao?: string | null
          id?: string
          updated_at?: string | null
          valor?: string | null
        }
        Update: {
          chave?: string
          descricao?: string | null
          id?: string
          updated_at?: string | null
          valor?: string | null
        }
        Relationships: []
      }
      fin_contas_bancarias: {
        Row: {
          agencia: string | null
          ativa: boolean | null
          banco: string | null
          conta: string | null
          created_at: string | null
          gc_id: string | null
          id: string
          is_inter: boolean | null
          nome: string
          saldo_atual: number | null
          saldo_inicial: number | null
          tipo: string | null
          updated_at: string | null
        }
        Insert: {
          agencia?: string | null
          ativa?: boolean | null
          banco?: string | null
          conta?: string | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          is_inter?: boolean | null
          nome: string
          saldo_atual?: number | null
          saldo_inicial?: number | null
          tipo?: string | null
          updated_at?: string | null
        }
        Update: {
          agencia?: string | null
          ativa?: boolean | null
          banco?: string | null
          conta?: string | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          is_inter?: boolean | null
          nome?: string
          saldo_atual?: number | null
          saldo_inicial?: number | null
          tipo?: string | null
          updated_at?: string | null
        }
        Relationships: []
      }
      fin_extrato_inter: {
        Row: {
          agenda_id: string | null
          chave_pix: string | null
          codigo_barras: string | null
          contrapartida: string | null
          cpf_cnpj: string | null
          created_at: string | null
          data_hora: string | null
          descricao: string | null
          end_to_end_id: string | null
          grupo_pagar_id: string | null
          grupo_receber_id: string | null
          id: string
          lancamento_id: string | null
          nome_contraparte: string | null
          payload_raw: Json | null
          reconciliado: boolean | null
          reconciliado_em: string | null
          reconciliation_rule: string | null
          tipo: string | null
          tipo_transacao: string | null
          valor: number | null
        }
        Insert: {
          agenda_id?: string | null
          chave_pix?: string | null
          codigo_barras?: string | null
          contrapartida?: string | null
          cpf_cnpj?: string | null
          created_at?: string | null
          data_hora?: string | null
          descricao?: string | null
          end_to_end_id?: string | null
          grupo_pagar_id?: string | null
          grupo_receber_id?: string | null
          id?: string
          lancamento_id?: string | null
          nome_contraparte?: string | null
          payload_raw?: Json | null
          reconciliado?: boolean | null
          reconciliado_em?: string | null
          reconciliation_rule?: string | null
          tipo?: string | null
          tipo_transacao?: string | null
          valor?: number | null
        }
        Update: {
          agenda_id?: string | null
          chave_pix?: string | null
          codigo_barras?: string | null
          contrapartida?: string | null
          cpf_cnpj?: string | null
          created_at?: string | null
          data_hora?: string | null
          descricao?: string | null
          end_to_end_id?: string | null
          grupo_pagar_id?: string | null
          grupo_receber_id?: string | null
          id?: string
          lancamento_id?: string | null
          nome_contraparte?: string | null
          payload_raw?: Json | null
          reconciliado?: boolean | null
          reconciliado_em?: string | null
          reconciliation_rule?: string | null
          tipo?: string | null
          tipo_transacao?: string | null
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_extrato_inter_agenda_id_fkey"
            columns: ["agenda_id"]
            isOneToOne: false
            referencedRelation: "fin_agenda_pagamentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_extrato_inter_grupo_pagar_id_fkey"
            columns: ["grupo_pagar_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_pagar"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_extrato_inter_grupo_receber_id_fkey"
            columns: ["grupo_receber_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_receber"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_extrato_lancamentos: {
        Row: {
          created_at: string | null
          extrato_id: string
          id: string
          lancamento_id: string
          reconciliation_rule: string | null
          tabela: string
          valor_alocado: number | null
        }
        Insert: {
          created_at?: string | null
          extrato_id: string
          id?: string
          lancamento_id: string
          reconciliation_rule?: string | null
          tabela: string
          valor_alocado?: number | null
        }
        Update: {
          created_at?: string | null
          extrato_id?: string
          id?: string
          lancamento_id?: string
          reconciliation_rule?: string | null
          tabela?: string
          valor_alocado?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_extrato_lancamentos_extrato_id_fkey"
            columns: ["extrato_id"]
            isOneToOne: false
            referencedRelation: "fin_extrato_inter"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_extrato_lancamentos_extrato_id_fkey"
            columns: ["extrato_id"]
            isOneToOne: false
            referencedRelation: "vw_conciliacao_extrato"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_formas_pagamento: {
        Row: {
          ativo: boolean | null
          created_at: string | null
          gc_id: string | null
          id: string
          nome: string
          tipo: string | null
        }
        Insert: {
          ativo?: boolean | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          nome: string
          tipo?: string | null
        }
        Update: {
          ativo?: boolean | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          nome?: string
          tipo?: string | null
        }
        Relationships: []
      }
      fin_fornecedores: {
        Row: {
          bairro: string | null
          cep: string | null
          chave_pix: string | null
          cidade: string | null
          cpf_cnpj: string | null
          data_cadastro: string | null
          email: string | null
          endereco: string | null
          estado: string | null
          gc_id: string
          id: string
          last_synced: string | null
          nome: string
          nome_fantasia: string | null
          observacao: string | null
          payload_raw: Json | null
          razao_social: string | null
          telefone: string | null
          tipo_pessoa: string | null
        }
        Insert: {
          bairro?: string | null
          cep?: string | null
          chave_pix?: string | null
          cidade?: string | null
          cpf_cnpj?: string | null
          data_cadastro?: string | null
          email?: string | null
          endereco?: string | null
          estado?: string | null
          gc_id: string
          id?: string
          last_synced?: string | null
          nome: string
          nome_fantasia?: string | null
          observacao?: string | null
          payload_raw?: Json | null
          razao_social?: string | null
          telefone?: string | null
          tipo_pessoa?: string | null
        }
        Update: {
          bairro?: string | null
          cep?: string | null
          chave_pix?: string | null
          cidade?: string | null
          cpf_cnpj?: string | null
          data_cadastro?: string | null
          email?: string | null
          endereco?: string | null
          estado?: string | null
          gc_id?: string
          id?: string
          last_synced?: string | null
          nome?: string
          nome_fantasia?: string | null
          observacao?: string | null
          payload_raw?: Json | null
          razao_social?: string | null
          telefone?: string | null
          tipo_pessoa?: string | null
        }
        Relationships: []
      }
      fin_grupo_pagar_itens: {
        Row: {
          created_at: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          grupo_id: string
          id: string
          pagamento_id: string
          tentativas: number | null
          ultimo_erro: string | null
          valor: number | null
        }
        Insert: {
          created_at?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          grupo_id: string
          id?: string
          pagamento_id: string
          tentativas?: number | null
          ultimo_erro?: string | null
          valor?: number | null
        }
        Update: {
          created_at?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          grupo_id?: string
          id?: string
          pagamento_id?: string
          tentativas?: number | null
          ultimo_erro?: string | null
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_grupo_pagar_itens_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_pagar"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_grupo_pagar_itens_pagamento_id_fkey"
            columns: ["pagamento_id"]
            isOneToOne: false
            referencedRelation: "fin_pagamentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_grupo_receber_itens: {
        Row: {
          created_at: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          gc_os_id: string | null
          grupo_id: string
          id: string
          os_codigo_original: string | null
          recebimento_id: string
          snapshot_data: string | null
          snapshot_valor: number | null
          tentativas: number | null
          ultimo_erro: string | null
          valor: number | null
        }
        Insert: {
          created_at?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_os_id?: string | null
          grupo_id: string
          id?: string
          os_codigo_original?: string | null
          recebimento_id: string
          snapshot_data?: string | null
          snapshot_valor?: number | null
          tentativas?: number | null
          ultimo_erro?: string | null
          valor?: number | null
        }
        Update: {
          created_at?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_os_id?: string | null
          grupo_id?: string
          id?: string
          os_codigo_original?: string | null
          recebimento_id?: string
          snapshot_data?: string | null
          snapshot_valor?: number | null
          tentativas?: number | null
          ultimo_erro?: string | null
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_grupo_receber_itens_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_receber"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_grupo_receber_itens_recebimento_id_fkey"
            columns: ["recebimento_id"]
            isOneToOne: false
            referencedRelation: "fin_recebimentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_grupos_pagar: {
        Row: {
          created_at: string | null
          created_by: string | null
          data_pagamento: string | null
          data_vencimento: string | null
          fornecedor_gc_id: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          gc_baixado_por: string | null
          id: string
          inter_favorecido: string | null
          inter_pagamento_id: string | null
          inter_pago_em: string | null
          itens_baixados: number | null
          itens_total: number | null
          nome: string
          nome_fornecedor: string | null
          observacao: string | null
          status: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at: string | null
          valor_pago: number | null
          valor_total: number | null
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_baixado_por?: string | null
          id?: string
          inter_favorecido?: string | null
          inter_pagamento_id?: string | null
          inter_pago_em?: string | null
          itens_baixados?: number | null
          itens_total?: number | null
          nome: string
          nome_fornecedor?: string | null
          observacao?: string | null
          status?: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at?: string | null
          valor_pago?: number | null
          valor_total?: number | null
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_baixado_por?: string | null
          id?: string
          inter_favorecido?: string | null
          inter_pagamento_id?: string | null
          inter_pago_em?: string | null
          itens_baixados?: number | null
          itens_total?: number | null
          nome?: string
          nome_fornecedor?: string | null
          observacao?: string | null
          status?: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at?: string | null
          valor_pago?: number | null
          valor_total?: number | null
        }
        Relationships: []
      }
      fin_grupos_receber: {
        Row: {
          cliente_gc_id: string | null
          created_at: string | null
          created_by: string | null
          data_pagamento: string | null
          data_vencimento: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          gc_baixado_por: string | null
          id: string
          inter_copia_cola: string | null
          inter_pagador: string | null
          inter_pago_em: string | null
          inter_qrcode: string | null
          inter_txid: string | null
          itens_baixados: number | null
          itens_total: number | null
          nome: string
          nome_cliente: string | null
          observacao: string | null
          status: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at: string | null
          valor_recebido: number | null
          valor_total: number | null
        }
        Insert: {
          cliente_gc_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_baixado_por?: string | null
          id?: string
          inter_copia_cola?: string | null
          inter_pagador?: string | null
          inter_pago_em?: string | null
          inter_qrcode?: string | null
          inter_txid?: string | null
          itens_baixados?: number | null
          itens_total?: number | null
          nome: string
          nome_cliente?: string | null
          observacao?: string | null
          status?: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at?: string | null
          valor_recebido?: number | null
          valor_total?: number | null
        }
        Update: {
          cliente_gc_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_baixado_por?: string | null
          id?: string
          inter_copia_cola?: string | null
          inter_pagador?: string | null
          inter_pago_em?: string | null
          inter_qrcode?: string | null
          inter_txid?: string | null
          itens_baixados?: number | null
          itens_total?: number | null
          nome?: string
          nome_cliente?: string | null
          observacao?: string | null
          status?: Database["public"]["Enums"]["fin_status_grupo"] | null
          updated_at?: string | null
          valor_recebido?: number | null
          valor_total?: number | null
        }
        Relationships: []
      }
      fin_metas: {
        Row: {
          alerta_pct: number | null
          ativo: boolean | null
          centro_custo_id: string | null
          created_at: string | null
          id: string
          nome: string
          observacao: string | null
          periodo_ano: number
          periodo_mes: number | null
          periodo_tipo: string
          periodo_trimestre: number | null
          plano_contas_id: string | null
          tipo: string
          updated_at: string | null
          valor_meta: number
        }
        Insert: {
          alerta_pct?: number | null
          ativo?: boolean | null
          centro_custo_id?: string | null
          created_at?: string | null
          id?: string
          nome: string
          observacao?: string | null
          periodo_ano: number
          periodo_mes?: number | null
          periodo_tipo: string
          periodo_trimestre?: number | null
          plano_contas_id?: string | null
          tipo: string
          updated_at?: string | null
          valor_meta: number
        }
        Update: {
          alerta_pct?: number | null
          ativo?: boolean | null
          centro_custo_id?: string | null
          created_at?: string | null
          id?: string
          nome?: string
          observacao?: string | null
          periodo_ano?: number
          periodo_mes?: number | null
          periodo_tipo?: string
          periodo_trimestre?: number | null
          plano_contas_id?: string | null
          tipo?: string
          updated_at?: string | null
          valor_meta?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_metas_centro_custo_id_fkey"
            columns: ["centro_custo_id"]
            isOneToOne: false
            referencedRelation: "fin_centros_custo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_metas_plano_contas_id_fkey"
            columns: ["plano_contas_id"]
            isOneToOne: false
            referencedRelation: "fin_plano_contas"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_pagamentos: {
        Row: {
          aguardando_nf: boolean | null
          centro_custo_id: string | null
          conta_bancaria_id: string | null
          created_at: string | null
          created_by: string | null
          data_competencia: string | null
          data_emissao: string | null
          data_liquidacao: string | null
          data_vencimento: string | null
          desconto: number | null
          descricao: string
          forma_pagamento_id: string | null
          fornecedor_gc_id: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          gc_codigo: string | null
          gc_id: string | null
          gc_payload_raw: Json | null
          grupo_id: string | null
          id: string
          last_synced_at: string | null
          liquidado: boolean | null
          nf_numero: string | null
          nfe_chave: string | null
          nfe_vinculada_em: string | null
          nome_fornecedor: string | null
          observacao: string | null
          origem: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo: string | null
          pago_sistema: boolean | null
          pago_sistema_em: string | null
          plano_contas_id: string | null
          recipient_document: string | null
          recorrencia: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id: string | null
          status: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo: string | null
          updated_at: string | null
          valor: number
        }
        Insert: {
          aguardando_nf?: boolean | null
          centro_custo_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_competencia?: string | null
          data_emissao?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao: string
          forma_pagamento_id?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_codigo?: string | null
          gc_id?: string | null
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nf_numero?: string | null
          nfe_chave?: string | null
          nfe_vinculada_em?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          origem?: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo?: string | null
          pago_sistema?: boolean | null
          pago_sistema_em?: string | null
          plano_contas_id?: string | null
          recipient_document?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo?: string | null
          updated_at?: string | null
          valor: number
        }
        Update: {
          aguardando_nf?: boolean | null
          centro_custo_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_competencia?: string | null
          data_emissao?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao?: string
          forma_pagamento_id?: string | null
          fornecedor_gc_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_codigo?: string | null
          gc_id?: string | null
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nf_numero?: string | null
          nfe_chave?: string | null
          nfe_vinculada_em?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          origem?: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo?: string | null
          pago_sistema?: boolean | null
          pago_sistema_em?: string | null
          plano_contas_id?: string | null
          recipient_document?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo?: string | null
          updated_at?: string | null
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_pagamentos_centro_custo_id_fkey"
            columns: ["centro_custo_id"]
            isOneToOne: false
            referencedRelation: "fin_centros_custo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_pagamentos_conta_bancaria_id_fkey"
            columns: ["conta_bancaria_id"]
            isOneToOne: false
            referencedRelation: "fin_contas_bancarias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_pagamentos_forma_pagamento_id_fkey"
            columns: ["forma_pagamento_id"]
            isOneToOne: false
            referencedRelation: "fin_formas_pagamento"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_pagamentos_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_pagar"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_pagamentos_plano_contas_id_fkey"
            columns: ["plano_contas_id"]
            isOneToOne: false
            referencedRelation: "fin_plano_contas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_pagamentos_recorrencia_pai_id_fkey"
            columns: ["recorrencia_pai_id"]
            isOneToOne: false
            referencedRelation: "fin_pagamentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_plano_contas: {
        Row: {
          ativo: boolean | null
          codigo: string | null
          created_at: string | null
          gc_id: string | null
          id: string
          nome: string
          pai_id: string | null
          tipo: Database["public"]["Enums"]["fin_tipo_lancamento"]
          updated_at: string | null
        }
        Insert: {
          ativo?: boolean | null
          codigo?: string | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          nome: string
          pai_id?: string | null
          tipo: Database["public"]["Enums"]["fin_tipo_lancamento"]
          updated_at?: string | null
        }
        Update: {
          ativo?: boolean | null
          codigo?: string | null
          created_at?: string | null
          gc_id?: string | null
          id?: string
          nome?: string
          pai_id?: string | null
          tipo?: Database["public"]["Enums"]["fin_tipo_lancamento"]
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "fin_plano_contas_pai_id_fkey"
            columns: ["pai_id"]
            isOneToOne: false
            referencedRelation: "fin_plano_contas"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_recebimentos: {
        Row: {
          centro_custo_id: string | null
          cliente_gc_id: string | null
          conta_bancaria_id: string | null
          created_at: string | null
          created_by: string | null
          data_competencia: string | null
          data_emissao: string | null
          data_liquidacao: string | null
          data_vencimento: string | null
          desconto: number | null
          descricao: string
          forma_pagamento_id: string | null
          gc_baixado: boolean | null
          gc_baixado_em: string | null
          gc_codigo: string | null
          gc_id: string | null
          gc_payload_raw: Json | null
          grupo_id: string | null
          id: string
          last_synced_at: string | null
          liquidado: boolean | null
          nf_numero: string | null
          nfe_chave: string | null
          nfe_numero: string | null
          nome_cliente: string | null
          observacao: string | null
          origem: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo: string | null
          pago_sistema: boolean | null
          pago_sistema_em: string | null
          plano_contas_id: string | null
          recipient_document: string | null
          recorrencia: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id: string | null
          status: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo: string | null
          updated_at: string | null
          valor: number
        }
        Insert: {
          centro_custo_id?: string | null
          cliente_gc_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_competencia?: string | null
          data_emissao?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao: string
          forma_pagamento_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_codigo?: string | null
          gc_id?: string | null
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nf_numero?: string | null
          nfe_chave?: string | null
          nfe_numero?: string | null
          nome_cliente?: string | null
          observacao?: string | null
          origem?: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo?: string | null
          pago_sistema?: boolean | null
          pago_sistema_em?: string | null
          plano_contas_id?: string | null
          recipient_document?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo?: string | null
          updated_at?: string | null
          valor: number
        }
        Update: {
          centro_custo_id?: string | null
          cliente_gc_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          created_by?: string | null
          data_competencia?: string | null
          data_emissao?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao?: string
          forma_pagamento_id?: string | null
          gc_baixado?: boolean | null
          gc_baixado_em?: string | null
          gc_codigo?: string | null
          gc_id?: string | null
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nf_numero?: string | null
          nfe_chave?: string | null
          nfe_numero?: string | null
          nome_cliente?: string | null
          observacao?: string | null
          origem?: Database["public"]["Enums"]["fin_origem"] | null
          os_codigo?: string | null
          pago_sistema?: boolean | null
          pago_sistema_em?: string | null
          plano_contas_id?: string | null
          recipient_document?: string | null
          recorrencia?: Database["public"]["Enums"]["fin_recorrencia"] | null
          recorrencia_pai_id?: string | null
          status?: Database["public"]["Enums"]["fin_status_lancamento"] | null
          tipo?: string | null
          updated_at?: string | null
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "fin_recebimentos_centro_custo_id_fkey"
            columns: ["centro_custo_id"]
            isOneToOne: false
            referencedRelation: "fin_centros_custo"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_recebimentos_conta_bancaria_id_fkey"
            columns: ["conta_bancaria_id"]
            isOneToOne: false
            referencedRelation: "fin_contas_bancarias"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_recebimentos_forma_pagamento_id_fkey"
            columns: ["forma_pagamento_id"]
            isOneToOne: false
            referencedRelation: "fin_formas_pagamento"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_recebimentos_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_receber"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_recebimentos_plano_contas_id_fkey"
            columns: ["plano_contas_id"]
            isOneToOne: false
            referencedRelation: "fin_plano_contas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_recebimentos_recorrencia_pai_id_fkey"
            columns: ["recorrencia_pai_id"]
            isOneToOne: false
            referencedRelation: "fin_recebimentos"
            referencedColumns: ["id"]
          },
        ]
      }
      fin_sync_log: {
        Row: {
          created_at: string | null
          duracao_ms: number | null
          erro: string | null
          id: string
          payload: Json | null
          referencia_id: string | null
          resposta: Json | null
          status: string
          tipo: string
        }
        Insert: {
          created_at?: string | null
          duracao_ms?: number | null
          erro?: string | null
          id?: string
          payload?: Json | null
          referencia_id?: string | null
          resposta?: Json | null
          status: string
          tipo: string
        }
        Update: {
          created_at?: string | null
          duracao_ms?: number | null
          erro?: string | null
          id?: string
          payload?: Json | null
          referencia_id?: string | null
          resposta?: Json | null
          status?: string
          tipo?: string
        }
        Relationships: []
      }
      gc_pagamentos: {
        Row: {
          centro_custo_id: string | null
          cliente_id: string | null
          conta_bancaria_id: string | null
          created_at: string | null
          data_competencia: string | null
          data_liquidacao: string | null
          data_vencimento: string | null
          descricao: string | null
          forma_pagamento_id: string | null
          fornecedor_id: string | null
          gc_codigo: string | null
          gc_id: string
          gc_payload_raw: Json | null
          id: string
          last_synced_at: string | null
          liquidado: boolean | null
          nome_centro_custo: string | null
          nome_conta_bancaria: string | null
          nome_forma_pagamento: string | null
          nome_fornecedor: string | null
          nome_plano_conta: string | null
          plano_contas_id: string | null
          updated_at: string | null
          valor: number
          valor_total: number | null
        }
        Insert: {
          centro_custo_id?: string | null
          cliente_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          data_competencia?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          descricao?: string | null
          forma_pagamento_id?: string | null
          fornecedor_id?: string | null
          gc_codigo?: string | null
          gc_id: string
          gc_payload_raw?: Json | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nome_centro_custo?: string | null
          nome_conta_bancaria?: string | null
          nome_forma_pagamento?: string | null
          nome_fornecedor?: string | null
          nome_plano_conta?: string | null
          plano_contas_id?: string | null
          updated_at?: string | null
          valor: number
          valor_total?: number | null
        }
        Update: {
          centro_custo_id?: string | null
          cliente_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          data_competencia?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          descricao?: string | null
          forma_pagamento_id?: string | null
          fornecedor_id?: string | null
          gc_codigo?: string | null
          gc_id?: string
          gc_payload_raw?: Json | null
          id?: string
          last_synced_at?: string | null
          liquidado?: boolean | null
          nome_centro_custo?: string | null
          nome_conta_bancaria?: string | null
          nome_forma_pagamento?: string | null
          nome_fornecedor?: string | null
          nome_plano_conta?: string | null
          plano_contas_id?: string | null
          updated_at?: string | null
          valor?: number
          valor_total?: number | null
        }
        Relationships: []
      }
      gc_recebimentos: {
        Row: {
          centro_custo_id: string | null
          cliente_id: string | null
          conta_bancaria_id: string | null
          created_at: string | null
          data_competencia: string | null
          data_liquidacao: string | null
          data_vencimento: string | null
          desconto: number | null
          descricao: string | null
          forma_pagamento_id: string | null
          fornecedor_id: string | null
          gc_codigo: string | null
          gc_id: string
          gc_payload_raw: Json | null
          grupo_id: string | null
          id: string
          juros: number | null
          last_synced_at: string | null
          liquidado: boolean | null
          nome_centro_custo: string | null
          nome_cliente: string | null
          nome_conta_bancaria: string | null
          nome_forma_pagamento: string | null
          nome_plano_conta: string | null
          os_codigo: string | null
          plano_contas_id: string | null
          tipo: string | null
          updated_at: string | null
          valor: number
          valor_total: number | null
        }
        Insert: {
          centro_custo_id?: string | null
          cliente_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          data_competencia?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao?: string | null
          forma_pagamento_id?: string | null
          fornecedor_id?: string | null
          gc_codigo?: string | null
          gc_id: string
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          juros?: number | null
          last_synced_at?: string | null
          liquidado?: boolean | null
          nome_centro_custo?: string | null
          nome_cliente?: string | null
          nome_conta_bancaria?: string | null
          nome_forma_pagamento?: string | null
          nome_plano_conta?: string | null
          os_codigo?: string | null
          plano_contas_id?: string | null
          tipo?: string | null
          updated_at?: string | null
          valor: number
          valor_total?: number | null
        }
        Update: {
          centro_custo_id?: string | null
          cliente_id?: string | null
          conta_bancaria_id?: string | null
          created_at?: string | null
          data_competencia?: string | null
          data_liquidacao?: string | null
          data_vencimento?: string | null
          desconto?: number | null
          descricao?: string | null
          forma_pagamento_id?: string | null
          fornecedor_id?: string | null
          gc_codigo?: string | null
          gc_id?: string
          gc_payload_raw?: Json | null
          grupo_id?: string | null
          id?: string
          juros?: number | null
          last_synced_at?: string | null
          liquidado?: boolean | null
          nome_centro_custo?: string | null
          nome_cliente?: string | null
          nome_conta_bancaria?: string | null
          nome_forma_pagamento?: string | null
          nome_plano_conta?: string | null
          os_codigo?: string | null
          plano_contas_id?: string | null
          tipo?: string | null
          updated_at?: string | null
          valor?: number
          valor_total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "gc_recebimentos_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "grupos_financeiros"
            referencedColumns: ["id"]
          },
        ]
      }
      grupo_itens: {
        Row: {
          baixado_gc: boolean | null
          baixado_gc_em: string | null
          created_at: string | null
          descricao: string | null
          erro_baixa: string | null
          gc_codigo: string | null
          gc_recebimento_id: string
          grupo_id: string
          id: string
          nome_cliente: string | null
          os_codigo: string | null
          tentativas: number | null
          valor: number
        }
        Insert: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          descricao?: string | null
          erro_baixa?: string | null
          gc_codigo?: string | null
          gc_recebimento_id: string
          grupo_id: string
          id?: string
          nome_cliente?: string | null
          os_codigo?: string | null
          tentativas?: number | null
          valor: number
        }
        Update: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          descricao?: string | null
          erro_baixa?: string | null
          gc_codigo?: string | null
          gc_recebimento_id?: string
          grupo_id?: string
          id?: string
          nome_cliente?: string | null
          os_codigo?: string | null
          tentativas?: number | null
          valor?: number
        }
        Relationships: [
          {
            foreignKeyName: "grupo_itens_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "grupos_financeiros"
            referencedColumns: ["id"]
          },
        ]
      }
      grupo_pagamento_itens: {
        Row: {
          baixado_gc: boolean | null
          baixado_gc_em: string | null
          created_at: string | null
          descricao: string | null
          erro_baixa: string | null
          gc_codigo: string | null
          gc_pagamento_id: string
          grupo_id: string
          id: string
          os_codigo: string | null
          tentativas: number | null
          valor: number | null
        }
        Insert: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          descricao?: string | null
          erro_baixa?: string | null
          gc_codigo?: string | null
          gc_pagamento_id: string
          grupo_id: string
          id?: string
          os_codigo?: string | null
          tentativas?: number | null
          valor?: number | null
        }
        Update: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          descricao?: string | null
          erro_baixa?: string | null
          gc_codigo?: string | null
          gc_pagamento_id?: string
          grupo_id?: string
          id?: string
          os_codigo?: string | null
          tentativas?: number | null
          valor?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "grupo_pagamento_itens_grupo_id_fkey"
            columns: ["grupo_id"]
            isOneToOne: false
            referencedRelation: "grupos_pagamentos"
            referencedColumns: ["id"]
          },
        ]
      }
      grupos_financeiros: {
        Row: {
          baixado_gc: boolean | null
          baixado_gc_em: string | null
          cliente_id: string | null
          created_at: string | null
          criado_por: string | null
          data_pagamento: string | null
          data_vencimento: string | null
          id: string
          inter_cobranca_id: string | null
          inter_copia_cola: string | null
          inter_qrcode: string | null
          inter_txid: string | null
          nome: string
          nome_cliente: string | null
          observacao: string | null
          qtd_itens: number | null
          status: string
          updated_at: string | null
          valor_recebido: number | null
          valor_total: number
        }
        Insert: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          cliente_id?: string | null
          created_at?: string | null
          criado_por?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          id?: string
          inter_cobranca_id?: string | null
          inter_copia_cola?: string | null
          inter_qrcode?: string | null
          inter_txid?: string | null
          nome: string
          nome_cliente?: string | null
          observacao?: string | null
          qtd_itens?: number | null
          status?: string
          updated_at?: string | null
          valor_recebido?: number | null
          valor_total?: number
        }
        Update: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          cliente_id?: string | null
          created_at?: string | null
          criado_por?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          id?: string
          inter_cobranca_id?: string | null
          inter_copia_cola?: string | null
          inter_qrcode?: string | null
          inter_txid?: string | null
          nome?: string
          nome_cliente?: string | null
          observacao?: string | null
          qtd_itens?: number | null
          status?: string
          updated_at?: string | null
          valor_recebido?: number | null
          valor_total?: number
        }
        Relationships: []
      }
      grupos_pagamentos: {
        Row: {
          baixado_gc: boolean | null
          baixado_gc_em: string | null
          created_at: string | null
          criado_por: string | null
          data_pagamento: string | null
          data_vencimento: string | null
          fornecedor_id: string | null
          id: string
          inter_pagamento_id: string | null
          nome: string
          nome_fornecedor: string | null
          observacao: string | null
          status: string
          updated_at: string | null
          valor_pago: number | null
          valor_total: number | null
        }
        Insert: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          criado_por?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          fornecedor_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome: string
          nome_fornecedor?: string | null
          observacao?: string | null
          status?: string
          updated_at?: string | null
          valor_pago?: number | null
          valor_total?: number | null
        }
        Update: {
          baixado_gc?: boolean | null
          baixado_gc_em?: string | null
          created_at?: string | null
          criado_por?: string | null
          data_pagamento?: string | null
          data_vencimento?: string | null
          fornecedor_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome?: string
          nome_fornecedor?: string | null
          observacao?: string | null
          status?: string
          updated_at?: string | null
          valor_pago?: number | null
          valor_total?: number | null
        }
        Relationships: []
      }
      os_index: {
        Row: {
          agrupado: boolean | null
          built_at: string | null
          id: string
          nome_cliente: string | null
          nome_situacao: string | null
          orc_codigo: string
          os_codigo: string
          os_id: string
          todos_orcs: string[] | null
        }
        Insert: {
          agrupado?: boolean | null
          built_at?: string | null
          id?: string
          nome_cliente?: string | null
          nome_situacao?: string | null
          orc_codigo: string
          os_codigo: string
          os_id: string
          todos_orcs?: string[] | null
        }
        Update: {
          agrupado?: boolean | null
          built_at?: string | null
          id?: string
          nome_cliente?: string | null
          nome_situacao?: string | null
          orc_codigo?: string
          os_codigo?: string
          os_id?: string
          todos_orcs?: string[] | null
        }
        Relationships: []
      }
      os_index_meta: {
        Row: {
          built_at: string | null
          id: number
          status: string | null
          total_agrupados: number | null
          total_os: number | null
          total_vinculos: number | null
        }
        Insert: {
          built_at?: string | null
          id?: number
          status?: string | null
          total_agrupados?: number | null
          total_os?: number | null
          total_vinculos?: number | null
        }
        Update: {
          built_at?: string | null
          id?: number
          status?: string | null
          total_agrupados?: number | null
          total_os?: number | null
          total_vinculos?: number | null
        }
        Relationships: []
      }
      pagamentos_programados: {
        Row: {
          baixado_gc: boolean | null
          chave_pix: string | null
          created_at: string | null
          data_vencimento: string
          descricao: string
          erro: string | null
          fornecedor_id: string | null
          frequencia: string | null
          gc_pagamento_id: string | null
          id: string
          inter_pagamento_id: string | null
          nome_fornecedor: string | null
          observacao: string | null
          recorrente: boolean | null
          status: string | null
          tipo_chave_pix: string | null
          updated_at: string | null
          valor: number
        }
        Insert: {
          baixado_gc?: boolean | null
          chave_pix?: string | null
          created_at?: string | null
          data_vencimento: string
          descricao: string
          erro?: string | null
          fornecedor_id?: string | null
          frequencia?: string | null
          gc_pagamento_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          recorrente?: boolean | null
          status?: string | null
          tipo_chave_pix?: string | null
          updated_at?: string | null
          valor: number
        }
        Update: {
          baixado_gc?: boolean | null
          chave_pix?: string | null
          created_at?: string | null
          data_vencimento?: string
          descricao?: string
          erro?: string | null
          fornecedor_id?: string | null
          frequencia?: string | null
          gc_pagamento_id?: string | null
          id?: string
          inter_pagamento_id?: string | null
          nome_fornecedor?: string | null
          observacao?: string | null
          recorrente?: boolean | null
          status?: string | null
          tipo_chave_pix?: string | null
          updated_at?: string | null
          valor?: number
        }
        Relationships: []
      }
      sync_log: {
        Row: {
          created_at: string | null
          duracao_ms: number | null
          erro: string | null
          id: string
          payload: Json | null
          referencia_id: string | null
          referencia_tipo: string | null
          resposta: Json | null
          status: string | null
          tipo: string
        }
        Insert: {
          created_at?: string | null
          duracao_ms?: number | null
          erro?: string | null
          id?: string
          payload?: Json | null
          referencia_id?: string | null
          referencia_tipo?: string | null
          resposta?: Json | null
          status?: string | null
          tipo: string
        }
        Update: {
          created_at?: string | null
          duracao_ms?: number | null
          erro?: string | null
          id?: string
          payload?: Json | null
          referencia_id?: string | null
          referencia_tipo?: string | null
          resposta?: Json | null
          status?: string | null
          tipo?: string
        }
        Relationships: []
      }
    }
    Views: {
      vw_conciliacao_extrato: {
        Row: {
          _tabela: string | null
          agenda_id: string | null
          chave_pix: string | null
          codigo_barras: string | null
          contrapartida: string | null
          cpf_cnpj: string | null
          created_at: string | null
          data_hora: string | null
          descricao: string | null
          diferenca: number | null
          end_to_end_id: string | null
          exato: boolean | null
          gc_codigo_vinculado: string | null
          gc_id_vinculado: string | null
          grupo_pagar_id: string | null
          grupo_receber_id: string | null
          id: string | null
          lancamento_id: string | null
          nome_contraparte: string | null
          payload_raw: Json | null
          qtd_parcelas: number | null
          reconciliado: boolean | null
          reconciliado_em: string | null
          reconciliation_rule: string | null
          tipo: string | null
          tipo_transacao: string | null
          valor_extrato: number | null
          valor_gc: number | null
        }
        Insert: {
          _tabela?: never
          agenda_id?: string | null
          chave_pix?: string | null
          codigo_barras?: string | null
          contrapartida?: string | null
          cpf_cnpj?: string | null
          created_at?: string | null
          data_hora?: string | null
          descricao?: string | null
          diferenca?: never
          end_to_end_id?: string | null
          exato?: never
          gc_codigo_vinculado?: never
          gc_id_vinculado?: never
          grupo_pagar_id?: string | null
          grupo_receber_id?: string | null
          id?: string | null
          lancamento_id?: string | null
          nome_contraparte?: string | null
          payload_raw?: Json | null
          qtd_parcelas?: never
          reconciliado?: boolean | null
          reconciliado_em?: string | null
          reconciliation_rule?: string | null
          tipo?: string | null
          tipo_transacao?: string | null
          valor_extrato?: number | null
          valor_gc?: never
        }
        Update: {
          _tabela?: never
          agenda_id?: string | null
          chave_pix?: string | null
          codigo_barras?: string | null
          contrapartida?: string | null
          cpf_cnpj?: string | null
          created_at?: string | null
          data_hora?: string | null
          descricao?: string | null
          diferenca?: never
          end_to_end_id?: string | null
          exato?: never
          gc_codigo_vinculado?: never
          gc_id_vinculado?: never
          grupo_pagar_id?: string | null
          grupo_receber_id?: string | null
          id?: string | null
          lancamento_id?: string | null
          nome_contraparte?: string | null
          payload_raw?: Json | null
          qtd_parcelas?: never
          reconciliado?: boolean | null
          reconciliado_em?: string | null
          reconciliation_rule?: string | null
          tipo?: string | null
          tipo_transacao?: string | null
          valor_extrato?: number | null
          valor_gc?: never
        }
        Relationships: [
          {
            foreignKeyName: "fin_extrato_inter_agenda_id_fkey"
            columns: ["agenda_id"]
            isOneToOne: false
            referencedRelation: "fin_agenda_pagamentos"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_extrato_inter_grupo_pagar_id_fkey"
            columns: ["grupo_pagar_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_pagar"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fin_extrato_inter_grupo_receber_id_fkey"
            columns: ["grupo_receber_id"]
            isOneToOne: false
            referencedRelation: "fin_grupos_receber"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      fin_origem:
        | "gc_os"
        | "gc_venda"
        | "gc_contrato"
        | "manual"
        | "inter"
        | "outro"
      fin_recorrencia:
        | "nenhuma"
        | "diaria"
        | "semanal"
        | "quinzenal"
        | "mensal"
        | "bimestral"
        | "trimestral"
        | "semestral"
        | "anual"
      fin_status_grupo:
        | "aberto"
        | "aguardando_pagamento"
        | "pago"
        | "pago_parcial"
        | "cancelado"
      fin_status_lancamento: "pendente" | "pago" | "vencido" | "cancelado"
      fin_tipo_lancamento: "receita" | "despesa"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      fin_origem: [
        "gc_os",
        "gc_venda",
        "gc_contrato",
        "manual",
        "inter",
        "outro",
      ],
      fin_recorrencia: [
        "nenhuma",
        "diaria",
        "semanal",
        "quinzenal",
        "mensal",
        "bimestral",
        "trimestral",
        "semestral",
        "anual",
      ],
      fin_status_grupo: [
        "aberto",
        "aguardando_pagamento",
        "pago",
        "pago_parcial",
        "cancelado",
      ],
      fin_status_lancamento: ["pendente", "pago", "vencido", "cancelado"],
      fin_tipo_lancamento: ["receita", "despesa"],
    },
  },
} as const
