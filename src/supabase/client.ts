import { setTimeout as delay } from "node:timers/promises";

import type {
  SupabaseConfig,
  WePingResponse,
  WeRecordMonitorRunPayload,
  WeRecordMonitorRunResponse,
  WeRecordedSnapshot,
} from "./types.js";

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_DELAYS_MS = [500, 1500] as const;
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

interface PostgrestErrorBody {
  code?: unknown;
  message?: unknown;
  details?: unknown;
  hint?: unknown;
}

export class SupabaseRpcError extends Error {
  readonly rpcName: string;
  readonly httpStatus: number | undefined;
  readonly pgCode: string | undefined;
  readonly details: string | undefined;
  readonly hint: string | undefined;

  constructor(options: {
    message: string;
    rpcName: string;
    httpStatus?: number;
    pgCode?: string;
    details?: string;
    hint?: string;
  }) {
    super(options.message);
    this.name = "SupabaseRpcError";
    this.rpcName = options.rpcName;
    this.httpStatus = options.httpStatus;
    this.pgCode = options.pgCode;
    this.details = options.details;
    this.hint = options.hint;
  }
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  const uniqueSecrets = new Set<string>();
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (secret.length > 0) {
      uniqueSecrets.add(secret);
    }
    if (trimmed.length > 0) {
      uniqueSecrets.add(trimmed);
    }
  }

  const orderedSecrets = [...uniqueSecrets].toSorted(
    (a, b) => b.length - a.length
  );

  let scrubbed = text;
  for (const secret of orderedSecrets) {
    scrubbed = scrubbed.replaceAll(secret, "[REDACTED]");
  }
  return scrubbed;
}

export function normalizeSupabaseUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new Error("SUPABASE_URL must not be empty");
  }

  const withoutTrailingSlashes = trimmed.replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(withoutTrailingSlashes);
  } catch {
    throw new Error("SUPABASE_URL must be a valid HTTP or HTTPS URL");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SUPABASE_URL must use http:// or https://");
  }

  return withoutTrailingSlashes;
}

export function buildSupabaseRpcHeaders(
  apiKey: string
): Record<string, string> {
  const trimmedKey = apiKey.trim();
  if (trimmedKey.length === 0) {
    throw new Error("SUPABASE_API_KEY must not be empty");
  }

  const headers: Record<string, string> = {
    apikey: trimmedKey,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  if (!trimmedKey.startsWith("sb_") && trimmedKey.split(".").length === 3) {
    headers.Authorization = `Bearer ${trimmedKey}`;
  }

  return headers;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

function buildRpcErrorFromResponse(
  rpcName: string,
  status: number,
  rawBody: string,
  secrets: readonly string[]
): SupabaseRpcError {
  let pgCode: string | undefined;
  let details: string | undefined;
  let hint: string | undefined;
  let detailMessage = rawBody.trim();

  if (detailMessage.length > 0) {
    try {
      const parsed: unknown = JSON.parse(detailMessage);
      if (isPlainRecord(parsed)) {
        const body = parsed as PostgrestErrorBody;
        if (typeof body.code === "string" && body.code.trim().length > 0) {
          pgCode = body.code.trim();
        }
        if (
          typeof body.message === "string" &&
          body.message.trim().length > 0
        ) {
          detailMessage = body.message.trim();
        }
        if (
          typeof body.details === "string" &&
          body.details.trim().length > 0
        ) {
          details = scrubSecrets(body.details.trim(), secrets);
        }
        if (typeof body.hint === "string" && body.hint.trim().length > 0) {
          hint = scrubSecrets(body.hint.trim(), secrets);
        }
      }
    } catch {
      // Non-JSON response body (for example, upstream gateway HTML); keep raw text.
    }
  }

  const scrubbedDetail = scrubSecrets(
    detailMessage.slice(0, 500) || "empty response body",
    secrets
  );
  const codePrefix = pgCode ? `[${pgCode}] ` : "";
  const message = `Supabase RPC ${rpcName} failed with HTTP ${status}: ${codePrefix}${scrubbedDetail}`;

  const errorOptions: ConstructorParameters<typeof SupabaseRpcError>[0] = {
    message,
    rpcName,
    httpStatus: status,
  };
  if (pgCode !== undefined) {
    errorOptions.pgCode = pgCode;
  }
  if (details !== undefined) {
    errorOptions.details = details;
  }
  if (hint !== undefined) {
    errorOptions.hint = hint;
  }
  return new SupabaseRpcError(errorOptions);
}

type RpcAttemptOutcome =
  | { kind: "ok"; data: Record<string, unknown> }
  | { kind: "retry"; error: SupabaseRpcError }
  | { kind: "fatal"; error: SupabaseRpcError };

async function performRpcAttempt(params: {
  endpoint: string;
  headers: Record<string, string>;
  serializedBody: string;
  rpcName: string;
  secrets: readonly string[];
}): Promise<RpcAttemptOutcome> {
  let response: Response;
  try {
    response = await fetch(params.endpoint, {
      method: "POST",
      headers: params.headers,
      body: params.serializedBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      kind: "retry",
      error: new SupabaseRpcError({
        message: `Supabase RPC ${params.rpcName} request failed: ${scrubSecrets(rawMessage, params.secrets)}`,
        rpcName: params.rpcName,
      }),
    };
  }

  if (!response.ok) {
    let rawBody = "";
    try {
      rawBody = await response.text();
    } catch {
      rawBody = "";
    }

    const rpcError = buildRpcErrorFromResponse(
      params.rpcName,
      response.status,
      rawBody,
      params.secrets
    );

    return {
      kind: isRetryableHttpStatus(response.status) ? "retry" : "fatal",
      error: rpcError,
    };
  }

  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    return {
      kind: "fatal",
      error: new SupabaseRpcError({
        message: `Supabase RPC ${params.rpcName} returned invalid JSON: ${scrubSecrets(rawMessage, params.secrets)}`,
        rpcName: params.rpcName,
        httpStatus: response.status,
      }),
    };
  }

  if (!isPlainRecord(parsed) || parsed.ok !== true) {
    return {
      kind: "fatal",
      error: new SupabaseRpcError({
        message: `Supabase RPC ${params.rpcName} returned an unexpected response payload (expected ok === true)`,
        rpcName: params.rpcName,
        httpStatus: response.status,
      }),
    };
  }

  return { kind: "ok", data: parsed };
}

async function executeRpcWithRetry(
  params: {
    endpoint: string;
    headers: Record<string, string>;
    serializedBody: string;
    rpcName: string;
    secrets: readonly string[];
  },
  attempt = 1
): Promise<Record<string, unknown>> {
  const outcome = await performRpcAttempt(params);
  if (outcome.kind === "ok") {
    return outcome.data;
  }

  const retryDelayMs = RETRY_DELAYS_MS[attempt - 1];
  if (
    outcome.kind === "retry" &&
    attempt < MAX_ATTEMPTS &&
    retryDelayMs !== undefined
  ) {
    await delay(retryDelayMs);
    return executeRpcWithRetry(params, attempt + 1);
  }

  throw outcome.error;
}

function callSupabaseRpc(
  config: SupabaseConfig,
  rpcName: string,
  body: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const baseUrl = normalizeSupabaseUrl(config.url);
  return executeRpcWithRetry({
    endpoint: `${baseUrl}/rest/v1/rpc/${rpcName}`,
    headers: buildSupabaseRpcHeaders(config.apiKey),
    serializedBody: JSON.stringify(body),
    rpcName,
    secrets: [config.apiKey, config.weMonitorSecret],
  });
}

function isRecordedSnapshot(value: unknown): value is WeRecordedSnapshot {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    typeof value.id === "number" &&
    typeof value.free_unit_type === "string" &&
    typeof value.free_unit_type_id === "string" &&
    typeof value.recorded_at === "string" &&
    typeof value.total_gb === "number" &&
    typeof value.used_gb === "number" &&
    typeof value.actual_remaining_gb === "number" &&
    (value.consumed_since_previous_gb === null ||
      typeof value.consumed_since_previous_gb === "number") &&
    (value.hours_since_previous === null ||
      typeof value.hours_since_previous === "number")
  );
}

export async function wePing(config: SupabaseConfig): Promise<WePingResponse> {
  const result = await callSupabaseRpc(config, "we_ping", {
    p_we_secret: config.weMonitorSecret,
  });

  if (
    typeof result.server_time !== "string" ||
    typeof result.total_snapshots !== "number" ||
    (result.last_run_at !== null && typeof result.last_run_at !== "string")
  ) {
    throw new SupabaseRpcError({
      message: "Supabase RPC we_ping returned an invalid response shape",
      rpcName: "we_ping",
    });
  }

  return {
    ok: true,
    server_time: result.server_time,
    total_snapshots: result.total_snapshots,
    last_run_at: result.last_run_at,
  };
}

export async function weRecordMonitorRun(
  config: SupabaseConfig,
  payload: WeRecordMonitorRunPayload
): Promise<WeRecordMonitorRunResponse> {
  const result = await callSupabaseRpc(config, "we_record_monitor_run", {
    p_we_secret: config.weMonitorSecret,
    p_payload: payload,
  });

  if (
    typeof result.run_id !== "number" ||
    typeof result.status !== "string" ||
    typeof result.snapshots_recorded !== "number" ||
    typeof result.server_time !== "string" ||
    !Array.isArray(result.snapshots) ||
    !result.snapshots.every((item) => isRecordedSnapshot(item))
  ) {
    throw new SupabaseRpcError({
      message:
        "Supabase RPC we_record_monitor_run returned an invalid response shape",
      rpcName: "we_record_monitor_run",
    });
  }

  return {
    ok: true,
    run_id: result.run_id,
    status: result.status,
    snapshots_recorded: result.snapshots_recorded,
    snapshots: result.snapshots,
    server_time: result.server_time,
  };
}
