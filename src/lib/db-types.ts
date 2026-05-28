export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      activities: {
        Row: {
          athlete_id: string
          avg_hr: number | null
          created_at: string
          distance_mi: number | null
          duration_sec: number | null
          elevation_ft: number | null
          id: string
          raw_json: Json | null
          source: string
          source_id: string
          start_at: string
          type: string | null
        }
        Insert: {
          athlete_id: string
          avg_hr?: number | null
          created_at?: string
          distance_mi?: number | null
          duration_sec?: number | null
          elevation_ft?: number | null
          id?: string
          raw_json?: Json | null
          source: string
          source_id: string
          start_at: string
          type?: string | null
        }
        Update: {
          athlete_id?: string
          avg_hr?: number | null
          created_at?: string
          distance_mi?: number | null
          duration_sec?: number | null
          elevation_ft?: number | null
          id?: string
          raw_json?: Json | null
          source?: string
          source_id?: string
          start_at?: string
          type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "activities_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_run_steps: {
        Row: {
          agent_run_id: string
          created_at: string
          id: string
          input_json: Json | null
          kind: string
          output_json: Json | null
          step_n: number
          tokens_in: number | null
          tokens_out: number | null
          tool_name: string | null
        }
        Insert: {
          agent_run_id: string
          created_at?: string
          id?: string
          input_json?: Json | null
          kind: string
          output_json?: Json | null
          step_n: number
          tokens_in?: number | null
          tokens_out?: number | null
          tool_name?: string | null
        }
        Update: {
          agent_run_id?: string
          created_at?: string
          id?: string
          input_json?: Json | null
          kind?: string
          output_json?: Json | null
          step_n?: number
          tokens_in?: number | null
          tokens_out?: number | null
          tool_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_run_steps_agent_run_id_fkey"
            columns: ["agent_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      agent_runs: {
        Row: {
          athlete_id: string
          cache_creation_input_tokens: number | null
          cache_read_input_tokens: number | null
          cost_usd: number | null
          created_at: string
          error: string | null
          finished_at: string | null
          id: string
          input_tokens: number | null
          kind: string
          model: string | null
          output_tokens: number | null
          result_summary: string | null
          started_at: string
        }
        Insert: {
          athlete_id: string
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          kind: string
          model?: string | null
          output_tokens?: number | null
          result_summary?: string | null
          started_at?: string
        }
        Update: {
          athlete_id?: string
          cache_creation_input_tokens?: number | null
          cache_read_input_tokens?: number | null
          cost_usd?: number | null
          created_at?: string
          error?: string | null
          finished_at?: string | null
          id?: string
          input_tokens?: number | null
          kind?: string
          model?: string | null
          output_tokens?: number | null
          result_summary?: string | null
          started_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      athletes: {
        Row: {
          asthma: boolean
          checkin_state: Json
          created_at: string
          dob: string | null
          id: string
          name: string
          notes: string | null
          onboarding_state: Json
          sex: string | null
          shadow_bcc_until: string | null
          telegram_chat_id: string | null
          timezone: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          asthma?: boolean
          checkin_state?: Json
          created_at?: string
          dob?: string | null
          id?: string
          name: string
          notes?: string | null
          onboarding_state?: Json
          sex?: string | null
          shadow_bcc_until?: string | null
          telegram_chat_id?: string | null
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          asthma?: boolean
          checkin_state?: Json
          created_at?: string
          dob?: string | null
          id?: string
          name?: string
          notes?: string | null
          onboarding_state?: Json
          sex?: string | null
          shadow_bcc_until?: string | null
          telegram_chat_id?: string | null
          timezone?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "athletes_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      friend_allowlist: {
        Row: {
          added_by: string | null
          created_at: string
          email: string
          id: string
          note: string | null
        }
        Insert: {
          added_by?: string | null
          created_at?: string
          email: string
          id?: string
          note?: string | null
        }
        Update: {
          added_by?: string | null
          created_at?: string
          email?: string
          id?: string
          note?: string | null
        }
        Relationships: []
      }
      injuries: {
        Row: {
          athlete_id: string
          body_part: string
          created_at: string
          id: string
          notes: string | null
          severity: number | null
          started_at: string | null
          status: string
        }
        Insert: {
          athlete_id: string
          body_part: string
          created_at?: string
          id?: string
          notes?: string | null
          severity?: number | null
          started_at?: string | null
          status?: string
        }
        Update: {
          athlete_id?: string
          body_part?: string
          created_at?: string
          id?: string
          notes?: string | null
          severity?: number | null
          started_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "injuries_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_queue: {
        Row: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          key_unique: string
          kind: string
          last_error: string | null
          locked_at: string | null
          payload: Json
          run_after: string
        }
        Insert: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          key_unique: string
          kind: string
          last_error?: string | null
          locked_at?: string | null
          payload: Json
          run_after?: string
        }
        Update: {
          attempts?: number
          completed_at?: string | null
          created_at?: string
          id?: string
          key_unique?: string
          kind?: string
          last_error?: string | null
          locked_at?: string | null
          payload?: Json
          run_after?: string
        }
        Relationships: []
      }
      link_tokens: {
        Row: {
          athlete_id: string | null
          created_at: string
          email: string | null
          expires_at: string
          id: string
          plan_version_id: string | null
          purpose: string
          token: string
          used_at: string | null
        }
        Insert: {
          athlete_id?: string | null
          created_at?: string
          email?: string | null
          expires_at: string
          id?: string
          plan_version_id?: string | null
          purpose?: string
          token: string
          used_at?: string | null
        }
        Update: {
          athlete_id?: string | null
          created_at?: string
          email?: string | null
          expires_at?: string
          id?: string
          plan_version_id?: string | null
          purpose?: string
          token?: string
          used_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "link_tokens_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "link_tokens_plan_version_id_fkey"
            columns: ["plan_version_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      memory_files: {
        Row: {
          athlete_id: string
          content_md: string
          created_at: string
          file_name: string
          id: string
          updated_at: string
        }
        Insert: {
          athlete_id: string
          content_md?: string
          created_at?: string
          file_name: string
          id?: string
          updated_at?: string
        }
        Update: {
          athlete_id?: string
          content_md?: string
          created_at?: string
          file_name?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "memory_files_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      messages: {
        Row: {
          athlete_id: string
          body: string
          channel: string
          created_at: string
          direction: string
          id: string
          mirrored_to_admin: boolean
          related_run_id: string | null
          sent_at: string
        }
        Insert: {
          athlete_id: string
          body: string
          channel: string
          created_at?: string
          direction: string
          id?: string
          mirrored_to_admin?: boolean
          related_run_id?: string | null
          sent_at?: string
        }
        Update: {
          athlete_id?: string
          body?: string
          channel?: string
          created_at?: string
          direction?: string
          id?: string
          mirrored_to_admin?: boolean
          related_run_id?: string | null
          sent_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "messages_related_run_id_fkey"
            columns: ["related_run_id"]
            isOneToOne: false
            referencedRelation: "agent_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      oauth_tokens: {
        Row: {
          access_token_enc: string
          athlete_id: string
          created_at: string
          expires_at: string
          id: string
          provider: string
          provider_athlete_id: string | null
          refresh_token_enc: string
          updated_at: string
        }
        Insert: {
          access_token_enc: string
          athlete_id: string
          created_at?: string
          expires_at: string
          id?: string
          provider: string
          provider_athlete_id?: string | null
          refresh_token_enc: string
          updated_at?: string
        }
        Update: {
          access_token_enc?: string
          athlete_id?: string
          created_at?: string
          expires_at?: string
          id?: string
          provider?: string
          provider_athlete_id?: string | null
          refresh_token_enc?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "oauth_tokens_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      plan_versions: {
        Row: {
          created_at: string
          generated_at: string
          generated_by: string
          id: string
          plan_id: string
          plan_json: Json | null
          schema_version: number
          status: string
          supersedes_id: string | null
          version: number
        }
        Insert: {
          created_at?: string
          generated_at?: string
          generated_by: string
          id?: string
          plan_id: string
          plan_json?: Json | null
          schema_version?: number
          status: string
          supersedes_id?: string | null
          version?: number
        }
        Update: {
          created_at?: string
          generated_at?: string
          generated_by?: string
          id?: string
          plan_id?: string
          plan_json?: Json | null
          schema_version?: number
          status?: string
          supersedes_id?: string | null
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "plan_versions_plan_id_fkey"
            columns: ["plan_id"]
            isOneToOne: false
            referencedRelation: "plans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plan_versions_supersedes_id_fkey"
            columns: ["supersedes_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      plans: {
        Row: {
          athlete_id: string
          created_at: string
          current_version_id: string | null
          goal_race_id: string | null
          id: string
          start_date: string | null
          updated_at: string
          weeks: number | null
        }
        Insert: {
          athlete_id: string
          created_at?: string
          current_version_id?: string | null
          goal_race_id?: string | null
          id?: string
          start_date?: string | null
          updated_at?: string
          weeks?: number | null
        }
        Update: {
          athlete_id?: string
          created_at?: string
          current_version_id?: string | null
          goal_race_id?: string | null
          id?: string
          start_date?: string | null
          updated_at?: string
          weeks?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "plans_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_current_version_id_fkey"
            columns: ["current_version_id"]
            isOneToOne: false
            referencedRelation: "plan_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "plans_goal_race_id_fkey"
            columns: ["goal_race_id"]
            isOneToOne: false
            referencedRelation: "races"
            referencedColumns: ["id"]
          },
        ]
      }
      race_lookups: {
        Row: {
          created_at: string
          expires_at: string
          id: string
          name_lower: string
          result: Json
        }
        Insert: {
          created_at?: string
          expires_at: string
          id?: string
          name_lower: string
          result: Json
        }
        Update: {
          created_at?: string
          expires_at?: string
          id?: string
          name_lower?: string
          result?: Json
        }
        Relationships: []
      }
      races: {
        Row: {
          athlete_id: string
          created_at: string
          date: string | null
          distance_mi: number | null
          elevation_ft: number | null
          id: string
          name: string
          status: string
          target_time_sec: number | null
          target_type: string | null
          terrain: string | null
        }
        Insert: {
          athlete_id: string
          created_at?: string
          date?: string | null
          distance_mi?: number | null
          elevation_ft?: number | null
          id?: string
          name: string
          status?: string
          target_time_sec?: number | null
          target_type?: string | null
          terrain?: string | null
        }
        Update: {
          athlete_id?: string
          created_at?: string
          date?: string | null
          distance_mi?: number | null
          elevation_ft?: number | null
          id?: string
          name?: string
          status?: string
          target_time_sec?: number | null
          target_type?: string | null
          terrain?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "races_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string
          email: string
          id: string
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
        }
        Relationships: []
      }
    }
    Views: {
      athlete_cost_daily: {
        Row: {
          athlete_id: string | null
          cache_creation_input_tokens: number | null
          cache_read_input_tokens: number | null
          cost_usd: number | null
          input_tokens: number | null
          local_day: string | null
          output_tokens: number | null
          runs: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
      athlete_cost_rollup: {
        Row: {
          athlete_id: string | null
          cache_creation_input_tokens: number | null
          cache_read_input_tokens: number | null
          cost_usd: number | null
          cost_usd_28d: number | null
          cost_usd_7d: number | null
          first_run_at: string | null
          input_tokens: number | null
          last_run_at: string | null
          output_tokens: number | null
          runs_28d: number | null
          runs_7d: number | null
          total_runs: number | null
        }
        Relationships: [
          {
            foreignKeyName: "agent_runs_athlete_id_fkey"
            columns: ["athlete_id"]
            isOneToOne: false
            referencedRelation: "athletes"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accept_plan_paste: {
        Args: {
          p_link_token_id: string
          p_plan_id: string
          p_plan_json: Json
          p_plan_version_id: string
          p_start_date: string
          p_total_weeks: number
        }
        Returns: undefined
      }
      claim_next_job: {
        Args: { p_stale_minutes?: number }
        Returns: {
          attempts: number
          completed_at: string | null
          created_at: string
          id: string
          key_unique: string
          kind: string
          last_error: string | null
          locked_at: string | null
          payload: Json
          run_after: string
        }
        SetofOptions: {
          from: "*"
          to: "job_queue"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      link_start_handshake: {
        Args: { p_telegram_chat_id: string; p_token: string }
        Returns: Json
      }
      set_onboarding_state: {
        Args: { p_athlete_id: string; p_new_state: Json }
        Returns: undefined
      }
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

