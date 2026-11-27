import "dotenv/config";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";

import { and, desc, eq } from "drizzle-orm";

import { db, pool } from "./db/index.js";
import { monitorRuns, usageSnapshots } from "./db/schema.js";
import type { MonitorRun, UsageSnapshot } from "./db/schema.js";
import { fetchHomeUsage, normalizeServiceNumber } from "./we/client.js";
import { WeApiError } from "./we/errors.js";
import type { CaptchaChallenge, QuotaSnapshot } from "./we/types.js";

const MS_PER_HOUR = 3_600_000;
const MINUTES_PER_HOUR = 60;
const ROUND_PRECISION = 10_000;
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

function roundMetric(value: number): number {
  return Math.round(value * ROUND_PRECISION) / ROUND_PRECISION;
}

function computeDeltas(
  current: QuotaSnapshot,
  previous: UsageSnapshot | undefined,
  recordedAt: Date
): {
  consumedSincePreviousGb: number | null;
  hoursSincePrevious: number | null;
} {
  if (!previous) {
    return { consumedSincePreviousGb: null, hoursSincePrevious: null };
  }

  const sameBillingCycle =
    current.effectiveAt !== null &&
    previous.effectiveAt !== null &&
    current.effectiveAt.getTime() === previous.effectiveAt.getTime();

  const hoursSincePrevious = roundMetric(
    (recordedAt.getTime() - previous.recordedAt.getTime()) / MS_PER_HOUR
  );

  if (!sameBillingCycle || current.usedGb < previous.usedGb) {
    return {
      consumedSincePreviousGb: null,
      hoursSincePrevious,
    };
  }

  return {
    consumedSincePreviousGb: roundMetric(current.usedGb - previous.usedGb),
    hoursSincePrevious,
  };
}

async function storeSnapshot(snapshot: QuotaSnapshot): Promise<UsageSnapshot> {
  const [previous] = await db
    .select()
    .from(usageSnapshots)
    .where(
      and(
        eq(usageSnapshots.serviceNumber, snapshot.serviceNumber),
        eq(usageSnapshots.freeUnitTypeId, snapshot.freeUnitTypeId)
      )
    )
    .orderBy(desc(usageSnapshots.recordedAt))
    .limit(1);

  const recordedAt = new Date();
  const { consumedSincePreviousGb, hoursSincePrevious } = computeDeltas(
    snapshot,
    previous,
    recordedAt
  );

  const [inserted] = await db
    .insert(usageSnapshots)
    .values({
      recordedAt,
      serviceNumber: snapshot.serviceNumber,
      subscriberId: snapshot.subscriberId,
      offerName: snapshot.offerName,
      freeUnitType: snapshot.freeUnitType,
      freeUnitTypeId: snapshot.freeUnitTypeId,
      measureUnit: snapshot.measureUnit,
      totalGb: snapshot.totalGb,
      usedGb: snapshot.usedGb,
      remainingGb: snapshot.remainingGb,
      actualRemainingGb: snapshot.actualRemainingGb,
      consumedSincePreviousGb,
      hoursSincePrevious,
      effectiveAt: snapshot.effectiveAt,
      expiresAt: snapshot.expiresAt,
      remainingDaysForRenewal: snapshot.remainingDaysForRenewal,
      rawDetails: snapshot.rawDetails,
    })
    .returning();

  if (!inserted) {
    throw new Error("Failed to insert usage snapshot into PostgreSQL");
  }

  return inserted;
}

async function recordMonitorRun(entry: {
  startedAt: Date;
  finishedAt: Date;
  serviceNumber: string;
  status: "success" | "failed_captcha" | "failed_error";
  failureReason: string | null;
  errorMessage: string | null;
  snapshotsRecorded: number;
}): Promise<MonitorRun | undefined> {
  const [inserted] = await db.insert(monitorRuns).values(entry).returning();
  return inserted;
}

function classifyFailure(error: unknown): {
  status: "failed_captcha" | "failed_error";
  failureReason: string;
  errorMessage: string;
} {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const errorMessage = rawMessage.slice(0, MAX_ERROR_MESSAGE_LENGTH);

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

async function run(): Promise<void> {
  const startedAt = new Date();
  const serviceNumber = requireEnv("SERVICE_NUMBER");
  const password = requireEnv("PASSWORD");
  const { acctId: normalizedServiceNumber } =
    normalizeServiceNumber(serviceNumber);

  const allowInteractiveCaptcha =
    !process.argv.includes("--no-interactive") &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    process.env.CI !== "true";

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

    const savedSnapshots = await Promise.all(
      snapshots.map((snapshot) => storeSnapshot(snapshot))
    );

    await recordMonitorRun({
      startedAt,
      finishedAt: new Date(),
      serviceNumber: normalizedServiceNumber,
      status: "success",
      failureReason: null,
      errorMessage: null,
      snapshotsRecorded: savedSnapshots.length,
    });

    for (const saved of savedSnapshots) {
      const deltaLabel =
        saved.consumedSincePreviousGb === null
          ? "n/a (initial or cycle reset)"
          : `${saved.consumedSincePreviousGb.toFixed(2)} GB over ${formatElapsedDuration(saved.hoursSincePrevious)}`;
      const renewalLabel =
        saved.remainingDaysForRenewal === null
          ? ""
          : ` (${saved.remainingDaysForRenewal}d left)`;

      console.info(
        `[WE Usage] ${saved.offerName} | Used: ${saved.usedGb.toFixed(2)} / ${saved.totalGb.toFixed(2)} GB | Remaining: ${saved.remainingGb.toFixed(2)} GB | Delta: ${deltaLabel} | Cycle: ${formatCycleDate(saved.effectiveAt)} -> ${formatCycleDate(saved.expiresAt)}${renewalLabel} | Recorded ID: ${saved.id}`
      );
    }
  } catch (error) {
    const failure = classifyFailure(error);
    try {
      const recordedRun = await recordMonitorRun({
        startedAt,
        finishedAt: new Date(),
        serviceNumber: normalizedServiceNumber,
        status: failure.status,
        failureReason: failure.failureReason,
        errorMessage: failure.errorMessage,
        snapshotsRecorded: 0,
      });
      if (recordedRun) {
        console.error(
          `[WE Monitor] Recorded failed run ID ${recordedRun.id} (${recordedRun.status}: ${recordedRun.failureReason ?? "unknown"}).`
        );
      }
    } catch (dbError) {
      console.error("Also failed to record run status in database:", dbError);
    }

    throw error;
  }
}

try {
  await run();
} catch (error) {
  console.error("Failed to fetch and store WE usage snapshot:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
