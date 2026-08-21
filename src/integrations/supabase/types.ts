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
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      omo_audit: {
        Row: {
          at: string
          created_at: string
          id: string
          inputs: Json
          matched_at: string | null
          mint: string | null
          note: string | null
          phase: string
          rules: Json
          side: string | null
          signature: string | null
          symbol: string | null
          usd_target: number
          verdict: string
        }
        Insert: {
          at?: string
          created_at?: string
          id?: string
          inputs?: Json
          matched_at?: string | null
          mint?: string | null
          note?: string | null
          phase?: string
          rules?: Json
          side?: string | null
          signature?: string | null
          symbol?: string | null
          usd_target?: number
          verdict?: string
        }
        Update: {
          at?: string
          created_at?: string
          id?: string
          inputs?: Json
          matched_at?: string | null
          mint?: string | null
          note?: string | null
          phase?: string
          rules?: Json
          side?: string | null
          signature?: string | null
          symbol?: string | null
          usd_target?: number
          verdict?: string
        }
        Relationships: []
      }
      omo_commits: {
        Row: {
          audit_id: string | null
          commit_hash: string
          created_at: string
          decision_at: string
          fill_at: string | null
          fill_signature: string | null
          id: string
          memo_signature: string | null
          memo_slot: number | null
          mint: string | null
          nonce: string
          payload: Json
          publish_latency_ms: number | null
          published_at: string | null
          revealed: boolean
          revealed_at: string | null
          side: string | null
          status: string
          symbol: string | null
          verdict: string
        }
        Insert: {
          audit_id?: string | null
          commit_hash: string
          created_at?: string
          decision_at?: string
          fill_at?: string | null
          fill_signature?: string | null
          id?: string
          memo_signature?: string | null
          memo_slot?: number | null
          mint?: string | null
          nonce: string
          payload?: Json
          publish_latency_ms?: number | null
          published_at?: string | null
          revealed?: boolean
          revealed_at?: string | null
          side?: string | null
          status?: string
          symbol?: string | null
          verdict?: string
        }
        Update: {
          audit_id?: string | null
          commit_hash?: string
          created_at?: string
          decision_at?: string
          fill_at?: string | null
          fill_signature?: string | null
          id?: string
          memo_signature?: string | null
          memo_slot?: number | null
          mint?: string | null
          nonce?: string
          payload?: Json
          publish_latency_ms?: number | null
          published_at?: string | null
          revealed?: boolean
          revealed_at?: string | null
          side?: string | null
          status?: string
          symbol?: string | null
          verdict?: string
        }
        Relationships: []
      }
      omo_events: {
        Row: {
          at: string
          id: string
          kind: string
          meta: Json
          text: string
        }
        Insert: {
          at?: string
          id?: string
          kind: string
          meta?: Json
          text: string
        }
        Update: {
          at?: string
          id?: string
          kind?: string
          meta?: Json
          text?: string
        }
        Relationships: []
      }
      omo_memories: {
        Row: {
          created_at: string
          hits: number
          id: string
          note: string
          topic: string
          updated_at: string
          weight: number
        }
        Insert: {
          created_at?: string
          hits?: number
          id?: string
          note: string
          topic: string
          updated_at?: string
          weight?: number
        }
        Update: {
          created_at?: string
          hits?: number
          id?: string
          note?: string
          topic?: string
          updated_at?: string
          weight?: number
        }
        Relationships: []
      }
      omo_meta: {
        Row: {
          k: string
          updated_at: string
          v: Json
        }
        Insert: {
          k: string
          updated_at?: string
          v?: Json
        }
        Update: {
          k?: string
          updated_at?: string
          v?: Json
        }
        Relationships: []
      }
      omo_trades: {
        Row: {
          at: string
          created_at: string
          mint: string
          side: string
          signature: string
          sol_amount: number
          symbol: string
          token_amount: number
          usd_value: number
        }
        Insert: {
          at: string
          created_at?: string
          mint: string
          side: string
          signature: string
          sol_amount?: number
          symbol: string
          token_amount?: number
          usd_value?: number
        }
        Update: {
          at?: string
          created_at?: string
          mint?: string
          side?: string
          signature?: string
          sol_amount?: number
          symbol?: string
          token_amount?: number
          usd_value?: number
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
