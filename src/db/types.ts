export type SessionStatus = "online" | "offline" | "waiting" | "idle";
export type CollaborationMode = "plan" | "code" | "default";

export interface Project {
  channel_id: string;
  project_path: string;
  guild_id: string;
  auto_approve: number;
  codex_model: string | null;
  reasoning_effort: string | null;
  collaboration_mode: CollaborationMode | null;
  created_at: string;
}

export interface Session {
  id: string;
  channel_id: string;
  session_id: string | null; // Codex thread ID
  status: SessionStatus;
  last_activity: string | null;
  created_at: string;
}
