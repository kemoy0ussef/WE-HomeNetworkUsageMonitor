import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

export interface FreeUnitDetail {
  initialAmount: number;
  currentAmount: number;
  measureUnit: string;
  effectiveTime: number;
  expireTime: number;
  expireTimeCz?: number;
  originType: string;
  offeringName: string;
  isGroup: boolean;
  serviceNumber: string;
  itemCode: string;
  remainingDaysForRenewal?: number;
}

export const usageSnapshots = pgTable(
  "usage_snapshots",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    recordedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    serviceNumber: varchar({ length: 32 }).notNull(),
    subscriberId: varchar({ length: 32 }).notNull(),
    offerName: varchar({ length: 255 }).notNull(),
    freeUnitType: varchar({ length: 64 }).notNull(),
    freeUnitTypeId: varchar({ length: 64 }).notNull(),
    measureUnit: varchar({ length: 16 }).notNull(),
    totalGb: doublePrecision().notNull(),
    usedGb: doublePrecision().notNull(),
    remainingGb: doublePrecision().notNull(),
    actualRemainingGb: doublePrecision().notNull(),
    consumedSincePreviousGb: doublePrecision(),
    hoursSincePrevious: doublePrecision(),
    effectiveAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    remainingDaysForRenewal: integer(),
    rawDetails: jsonb().$type<FreeUnitDetail[]>().notNull(),
  },
  (table) => [
    index("usage_snapshots_service_unit_recorded_idx").on(
      table.serviceNumber,
      table.freeUnitTypeId,
      table.recordedAt
    ),
  ]
);

export const monitorRuns = pgTable(
  "monitor_runs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp({ withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp({ withTimezone: true }).notNull(),
    serviceNumber: varchar({ length: 32 }).notNull(),
    status: varchar({ length: 32 }).notNull(),
    failureReason: varchar({ length: 64 }),
    errorMessage: text(),
    snapshotsRecorded: integer().default(0).notNull(),
  },
  (table) => [
    index("monitor_runs_service_started_idx").on(
      table.serviceNumber,
      table.startedAt
    ),
  ]
);

export type UsageSnapshot = typeof usageSnapshots.$inferSelect;
export type NewUsageSnapshot = typeof usageSnapshots.$inferInsert;
export type MonitorRun = typeof monitorRuns.$inferSelect;
export type NewMonitorRun = typeof monitorRuns.$inferInsert;
