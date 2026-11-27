import type { FreeUnitDetail } from "../we/types.js";

export interface SupabaseConfig {
  url: string;
  apiKey: string;
  weMonitorSecret: string;
}

export type WeMonitorRunStatus = "success" | "failed_captcha" | "failed_error";

export interface WePingResponse {
  ok: true;
  server_time: string;
  total_snapshots: number;
  last_run_at: string | null;
}

export interface WeSnapshotInput {
  service_number: string;
  subscriber_id: string;
  offer_name: string;
  free_unit_type: string;
  free_unit_type_id: string;
  measure_unit: string;
  total_gb: number;
  used_gb: number;
  remaining_gb: number;
  actual_remaining_gb: number;
  recorded_at: string;
  effective_at: string | null;
  expires_at: string | null;
  remaining_days_for_renewal: number | null;
  raw_details: FreeUnitDetail[];
}

export interface WeRecordMonitorRunPayload {
  started_at: string;
  finished_at: string;
  service_number: string;
  status: WeMonitorRunStatus;
  failure_reason: string | null;
  error_message: string | null;
  snapshots: WeSnapshotInput[];
}

export interface WeRecordedSnapshot {
  id: number;
  free_unit_type: string;
  free_unit_type_id: string;
  recorded_at: string;
  total_gb: number;
  used_gb: number;
  actual_remaining_gb: number;
  consumed_since_previous_gb: number | null;
  hours_since_previous: number | null;
}

export interface WeRecordMonitorRunResponse {
  ok: true;
  run_id: number;
  status: string;
  snapshots_recorded: number;
  snapshots: WeRecordedSnapshot[];
  server_time: string;
}
