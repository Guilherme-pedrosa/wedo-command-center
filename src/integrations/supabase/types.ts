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
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
