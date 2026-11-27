import "dotenv/config";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import {
  normalizeSupabaseUrl,
  scrubSecrets,
  wePing,
  weRecordMonitorRun,
} from "./supabase/client.js";
import type {
  SupabaseConfig,
  WeMonitorRunStatus,
  WeRecordMonitorRunPayload,
  WeRecordedSnapshot,
  WeSnapshotInput,
} from "./supabase/types.js";
import { fetchHomeUsage, normalizeServiceNumber } from "./we/client.js";
import { WeApiError } from "./we/errors.js";
import type { CaptchaChallenge, QuotaSnapshot } from "./we/types.js";

const MINUTES_PER_HOUR = 60;
const MAX_ERROR_MESSAGE_LENGTH = 1000;
const CAIRO_DATE_FORMATTER = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Africa/Cairo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatCycleDate(date: Date | null): string {
  if (!date) {
    return "n/a";
  }
  return `${CAIRO_DATE_FORMATTER.format(date)} EET`;
}

function formatElapsedDuration(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) {
    return "?";
  }
  const totalMinutes = Math.max(0, Math.round(hours * MINUTES_PER_HOUR));
  const wholeHours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const remainingMinutes = totalMinutes % MINUTES_PER_HOUR;
  if (wholeHours === 0) {
    return `${remainingMinutes}m`;
  }
  return `${wholeHours}h ${remainingMinutes}m`;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadSupabaseConfig(): SupabaseConfig {
  return {
    url: normalizeSupabaseUrl(requireEnv("SUPABASE_URL")),
    apiKey: requireEnv("SUPABASE_API_KEY"),
    weMonitorSecret: requireEnv("WE_MONITOR_SECRET"),
  };
}

function collectActiveSecrets(extraSecrets: readonly string[] = []): string[] {
  const candidates = [
    process.env.SUPABASE_API_KEY,
    process.env.WE_MONITOR_SECRET,
    process.env.PASSWORD,
    ...extraSecrets,
  ];
  const active: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) {
      active.push(trimmed);
    }
  }
  return active;
}

function formatScrubbedError(
  error: unknown,
  secrets: readonly string[]
): string {
  if (error instanceof Error) {
    const base = error.stack ?? `${error.name}: ${error.message}`;
    const causeSuffix =
      error.cause === undefined
        ? ""
        : `\nCaused by: ${formatScrubbedError(error.cause, secrets)}`;
    return scrubSecrets(`${base}${causeSuffix}`, secrets);
  }
  return scrubSecrets(String(error), secrets);
}

function assertFiniteMetric(
  value: number,
  fieldName: string,
  snapshotLabel: string
): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `Invalid ${fieldName} (${String(value)}) for snapshot "${snapshotLabel}": expected a finite number`
    );
  }
  return value;
}

function toRequiredIsoString(date: Date, fieldName: string): string {
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Invalid ${fieldName} timestamp`);
  }
  return date.toISOString();
}

function toOptionalIsoString(
  date: Date | null,
  fieldName: string
): string | null {
  if (date === null) {
    return null;
  }
  return toRequiredIsoString(date, fieldName);
}

function sanitizeSnapshot(
  snapshot: QuotaSnapshot,
  recordedAtIso: string
): WeSnapshotInput {
  const label = `${snapshot.offerName} (${snapshot.freeUnitTypeId})`;
  const totalGb = assertFiniteMetric(snapshot.totalGb, "total_gb", label);
  const usedGb = assertFiniteMetric(snapshot.usedGb, "used_gb", label);
  const remainingGb = assertFiniteMetric(
    snapshot.remainingGb,
    "remaining_gb",
    label
  );
  const actualRemainingGb = assertFiniteMetric(
    snapshot.actualRemainingGb,
    "actual_remaining_gb",
    label
  );

  if (
    snapshot.remainingDaysForRenewal !== null &&
    !Number.isFinite(snapshot.remainingDaysForRenewal)
  ) {
    throw new Error(
      `Invalid remaining_days_for_renewal (${String(snapshot.remainingDaysForRenewal)}) for snapshot "${label}"`
    );
  }

  return {
    service_number: snapshot.serviceNumber,
    subscriber_id: snapshot.subscriberId,
    offer_name: snapshot.offerName,
    free_unit_type: snapshot.freeUnitType,
    free_unit_type_id: snapshot.freeUnitTypeId,
    measure_unit: snapshot.measureUnit,
    total_gb: totalGb,
    used_gb: usedGb,
    remaining_gb: remainingGb,
    actual_remaining_gb: actualRemainingGb,
    recorded_at: recordedAtIso,
    effective_at: toOptionalIsoString(snapshot.effectiveAt, "effective_at"),
    expires_at: toOptionalIsoString(snapshot.expiresAt, "expires_at"),
    remaining_days_for_renewal: snapshot.remainingDaysForRenewal,
    raw_details: snapshot.rawDetails,
  };
}

function buildMonitorRunPayload(params: {
  startedAt: Date;
  finishedAt: Date;
  serviceNumber: string;
  status: WeMonitorRunStatus;
  failureReason: string | null;
  errorMessage: string | null;
  snapshots: readonly QuotaSnapshot[];
}): WeRecordMonitorRunPayload {
  const startedAtIso = toRequiredIsoString(params.startedAt, "started_at");
  const finishedAtIso = toRequiredIsoString(params.finishedAt, "finished_at");

  return {
    started_at: startedAtIso,
    finished_at: finishedAtIso,
    service_number: params.serviceNumber,
    status: params.status,
    failure_reason: params.failureReason,
    error_message: params.errorMessage,
    snapshots: params.snapshots.map((snapshot) =>
      sanitizeSnapshot(snapshot, finishedAtIso)
    ),
  };
}

function pairRecordedSnapshots(
  localSnapshots: readonly QuotaSnapshot[],
  recordedSnapshots: readonly WeRecordedSnapshot[]
): {
  recorded: WeRecordedSnapshot;
  matched: QuotaSnapshot | undefined;
}[] {
  const localByUnitId = new Map<string, QuotaSnapshot[]>();
  for (const snapshot of localSnapshots) {
    const queue = localByUnitId.get(snapshot.freeUnitTypeId);
    if (queue) {
      queue.push(snapshot);
    } else {
      localByUnitId.set(snapshot.freeUnitTypeId, [snapshot]);
    }
  }

  return recordedSnapshots.map((recorded) => {
    const queue = localByUnitId.get(recorded.free_unit_type_id);
    const matched = queue?.shift();
    return { recorded, matched };
  });
}

function logRecordedSnapshots(
  localSnapshots: readonly QuotaSnapshot[],
  recordedSnapshots: readonly WeRecordedSnapshot[]
): void {
  const paired = pairRecordedSnapshots(localSnapshots, recordedSnapshots);
  for (const { recorded, matched } of paired) {
    const deltaLabel =
      recorded.consumed_since_previous_gb === null
        ? "n/a (initial or cycle reset)"
        : `${recorded.consumed_since_previous_gb.toFixed(2)} GB over ${formatElapsedDuration(recorded.hours_since_previous)}`;
    const renewalLabel =
      matched?.remainingDaysForRenewal === null ||
      matched?.remainingDaysForRenewal === undefined
        ? ""
        : ` (${matched.remainingDaysForRenewal}d left)`;

    const offerName = matched?.offerName ?? recorded.free_unit_type;
    const remainingGb = matched?.remainingGb ?? recorded.actual_remaining_gb;
    const effectiveAt = matched?.effectiveAt ?? null;
    const expiresAt = matched?.expiresAt ?? null;

    console.info(
      `[WE Usage] ${offerName} | Used: ${recorded.used_gb.toFixed(2)} / ${recorded.total_gb.toFixed(2)} GB | Remaining: ${remainingGb.toFixed(2)} GB | Delta: ${deltaLabel} | Cycle: ${formatCycleDate(effectiveAt)} -> ${formatCycleDate(expiresAt)}${renewalLabel} | Recorded ID: ${recorded.id}`
    );
  }
}

function classifyFailure(
  error: unknown,
  secrets: readonly string[]
): {
  status: "failed_captcha" | "failed_error";
  failureReason: string;
  errorMessage: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errorMessage = scrubSecrets(rawMessage, secrets).slice(
    0,
    MAX_ERROR_MESSAGE_LENGTH
  );

  if (error instanceof WeApiError && error.kind === "CAPTCHA_REQUIRED") {
    return {
      status: "failed_captcha",
      failureReason: "captcha_required",
      errorMessage,
    };
  }

  if (error instanceof WeApiError) {
    return {
      status: "failed_error",
      failureReason: error.errorNo ? `api_error_${error.errorNo}` : "api_error",
      errorMessage,
    };
  }

  return {
    status: "failed_error",
    failureReason: "unexpected_error",
    errorMessage,
  };
}

async function promptForCaptcha(
  challenge: CaptchaChallenge
): Promise<string | null> {
  const imagePath = path.resolve(
    process.cwd(),
    `captcha.${challenge.mimeExtension}`
  );
  await writeFile(imagePath, challenge.imageBytes);

  console.info(`\n[CAPTCHA Required] Saved CAPTCHA image to: ${imagePath}`);
  console.info(
    "Open the image above and enter the characters shown (leave blank to refresh, or type 'quit' to cancel)."
  );

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("CAPTCHA code: ");
    const trimmed = answer.trim();
    if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit") {
      return null;
    }
    return trimmed;
  } finally {
    rl.close();
    await rm(imagePath, { force: true });
  }
}

async function runPingMode(): Promise<void> {
  const supabaseConfig = loadSupabaseConfig();
  const ping = await wePing(supabaseConfig);
  console.info(
    `[WE Monitor] Supabase ping OK | Server time: ${ping.server_time} | Total snapshots: ${ping.total_snapshots} | Last run: ${ping.last_run_at ?? "never"}`
  );
}

async function runDryRunMode(allowInteractiveCaptcha: boolean): Promise<void> {
  const startedAt = new Date();
  const serviceNumber = requireEnv("SERVICE_NUMBER");
  const password = requireEnv("PASSWORD");
  const { acctId: normalizedServiceNumber } =
    normalizeServiceNumber(serviceNumber);
  const secrets = collectActiveSecrets([password]);

  const { snapshots } = await fetchHomeUsage(
    {
      serviceNumber,
      password,
    },
    allowInteractiveCaptcha
      ? { onCaptchaChallenge: promptForCaptcha }
      : undefined
  );

  const payload = buildMonitorRunPayload({
    startedAt,
    finishedAt: new Date(),
    serviceNumber: normalizedServiceNumber,
    status: "success",
    failureReason: null,
    errorMessage: null,
    snapshots,
  });

  console.info(scrubSecrets(JSON.stringify(payload, null, 2), secrets));
}

async function run(): Promise<void> {
  const isPingMode = process.argv.includes("--ping");
  const isDryRunMode = process.argv.includes("--dry-run");

  if (isPingMode && isDryRunMode) {
    throw new Error("Cannot combine --ping and --dry-run flags");
  }

  if (isPingMode) {
    await runPingMode();
    return;
  }

  const allowInteractiveCaptcha =
    !process.argv.includes("--no-interactive") &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    process.env.CI !== "true";

  if (isDryRunMode) {
    await runDryRunMode(allowInteractiveCaptcha);
    return;
  }

  const startedAt = new Date();
  const supabaseConfig = loadSupabaseConfig();
  const serviceNumber = requireEnv("SERVICE_NUMBER");
  const password = requireEnv("PASSWORD");
  const { acctId: normalizedServiceNumber } =
    normalizeServiceNumber(serviceNumber);
  const secrets = collectActiveSecrets([
    supabaseConfig.apiKey,
    supabaseConfig.weMonitorSecret,
    password,
  ]);

  await wePing(supabaseConfig);

  try {
    const { snapshots } = await fetchHomeUsage(
      {
        serviceNumber,
        password,
      },
      allowInteractiveCaptcha
        ? { onCaptchaChallenge: promptForCaptcha }
        : undefined
    );

    const payload = buildMonitorRunPayload({
      startedAt,
      finishedAt: new Date(),
      serviceNumber: normalizedServiceNumber,
      status: "success",
      failureReason: null,
      errorMessage: null,
      snapshots,
    });

    const recordedRun = await weRecordMonitorRun(supabaseConfig, payload);
    logRecordedSnapshots(snapshots, recordedRun.snapshots);
  } catch (error) {
    const failure = classifyFailure(error, secrets);
    try {
      const failurePayload = buildMonitorRunPayload({
        startedAt,
        finishedAt: new Date(),
        serviceNumber: normalizedServiceNumber,
        status: failure.status,
        failureReason: failure.failureReason,
        errorMessage: failure.errorMessage,
        snapshots: [],
      });
      const recordedRun = await weRecordMonitorRun(
        supabaseConfig,
        failurePayload
      );
      console.error(
        `[WE Monitor] Recorded failed run ID ${recordedRun.run_id} (${recordedRun.status}: ${failure.failureReason}).`
      );
    } catch (rpcError) {
      console.error(
        "Also failed to record run status in Supabase:",
        formatScrubbedError(rpcError, secrets)
      );
    }

    throw error;
  }
}

try {
  await run();
} catch (error) {
  console.error(
    "Failed to fetch and store WE usage snapshot:",
    formatScrubbedError(error, collectActiveSecrets())
  );
  process.exitCode = 1;
}
