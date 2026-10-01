import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type WatchState =
   | 'settlement_pending'
   | 'active'
   | 'matched'
   | 'settlement_unknown'
   | 'expired'
   | 'indeterminate';

export type WatchTerminalReason =
   | 'work_budget_exhausted'
   | 'indexer_permanent_failure';

export type PollingFailureDisposition =
   | 'permanent'
   | 'transient'
   | 'unknown';

export interface PollingFailure {
   code: string;
   status?: number;
   disposition: PollingFailureDisposition;
   retryAt?: Date;
}

export const DEFAULT_WATCH_TTL_MILLISECONDS = 30 * 60 * 1_000;
export const DEFAULT_MAX_OPEN_WATCHES = 50;
export const DEFAULT_MAX_OPEN_WATCHES_PER_PAYER = 5;
export const DEFAULT_WORK_UNIT_BUDGET = 500;
export const DEFAULT_READINESS_PROBE_INTERVAL_MILLISECONDS = 2_000;

export interface RoundWatchStoreOptions {
   watchTtlMilliseconds?: number;
   maxOpenWatches?: number;
   maxOpenWatchesPerPayer?: number;
   workUnitBudget?: number;
   readinessProbeIntervalMilliseconds?: number;
   now?: () => Date;
}

export type WatchCapacityScope = 'global' | 'payer';

export class WatchCapacityError extends Error {
   constructor(readonly scope: WatchCapacityScope) {
      super(`RoundWatch ${scope} open-obligation capacity is exhausted`);
      this.name = 'WatchCapacityError';
   }
}

export interface WatchSpec {
   idempotencyKey: string;
   expectedSender: string;
   expectedReceiver: string;
   assetId: number;
   atomicAmount: string;
   invoiceNote?: string;
}

export interface SettlementIntent {
   expectedTransaction: string;
   network: string;
   payer?: string;
   receiver: string;
   assetId: number;
   atomicAmount: string;
   firstValid: number;
   lastValid: number;
}

export interface WatchRecord extends WatchSpec {
   id: string;
   state: WatchState;
   expectedServiceTransaction?: string;
   expectedServiceNetwork?: string;
   expectedServicePayer?: string;
   serviceTransaction?: string;
   serviceNetwork?: string;
   servicePayer?: string;
   activationRound?: number;
   activatedAt?: string;
   scanAfterRound?: number;
   createdAt: string;
   expiresAt?: string;
   matchedTransaction?: string;
   matchedRound?: number;
   closingRound?: number;
   evidenceVersion: number;
   serviceReceiver?: string;
   serviceAssetId?: number;
   serviceAtomicAmount?: string;
   serviceFirstValid?: number;
   serviceLastValid?: number;
   reconciliationAttempts: number;
   reconciliationNextAttemptAt?: string;
   settlementReconciliationTerminal: boolean;
   workUnitBudget?: number;
   workUnitsUsed: number;
   terminalReason?: WatchTerminalReason;
   pollingFailureCode?: string;
   pollingFailureStatus?: number;
   pollingFailureDisposition?: PollingFailureDisposition;
   pollingFailureCount?: number;
   pollingLastFailureAt?: string;
   pollingRetryAt?: string;
}

export class LegacyIdempotencyReservationError extends Error {
   constructor() {
      super('Idempotency key is reserved by legacy state with unknown payer ownership');
      this.name = 'LegacyIdempotencyReservationError';
   }
}

export class IdempotencyConflictError extends Error {
   constructor(readonly existing: WatchRecord) {
      super('Idempotency key is already bound to a different watch specification');
      this.name = 'IdempotencyConflictError';
   }
}

export interface SettlementEvidence {
   transaction: string;
   network: string;
   payer?: string;
}

export interface RefundEvidence {
   transaction: string;
   network: string;
   atomicAmount: string;
   reason?: string;
}

export interface RefundRecord extends RefundEvidence {
   id: number;
   watchId: string;
   recordedAt: string;
}

interface WatchRow {
   id: string;
   idempotency_key: string;
   state: WatchState;
   expected_sender: string;
   expected_receiver: string;
   asset_id: number;
   atomic_amount: string;
   invoice_note: string | null;
   expected_service_transaction: string | null;
   expected_service_network: string | null;
   expected_service_payer: string | null;
   service_transaction: string | null;
   service_network: string | null;
   service_payer: string | null;
   activation_round: number | null;
   activated_at: string | null;
   scan_after_round: number | null;
   created_at: string;
   expires_at: string | null;
   matched_transaction: string | null;
   matched_round: number | null;
   settlement_reconciliation_terminal: number;
   closing_round: number | null;
   evidence_version: number;
   service_receiver: string | null;
   service_asset_id: number | null;
   service_atomic_amount: string | null;
   service_first_valid: number | null;
   service_last_valid: number | null;
   reconciliation_attempts: number;
   reconciliation_next_attempt_at: string | null;
   work_unit_budget: number | null;
   work_units_used: number;
   terminal_reason: WatchTerminalReason | null;
   polling_failure_code: string | null;
   polling_failure_status: number | null;
   polling_failure_disposition: PollingFailureDisposition | null;
   polling_failure_count: number;
   polling_last_failure_at: string | null;
   polling_retry_at: string | null;
}
interface RefundRow {
   id: number;
   watch_id: string;
   transaction_id: string;
   network: string;
   atomic_amount: string;
   reason: string | null;
   recorded_at: string;
}


export class RoundWatchStore {
   private readonly database: DatabaseSync;
   private readonly watchTtlMilliseconds: number;
   private readonly maxOpenWatches: number;
   private readonly maxOpenWatchesPerPayer: number;
   private readonly workUnitBudget: number;
   private readonly readinessProbeIntervalMilliseconds: number;
   private readonly now: () => Date;
   private closed = false;
   private lastReadinessProbeAt = Number.NEGATIVE_INFINITY;
   private lastReadinessProbeResult = false;

   constructor(
      databasePath: string,
      options: RoundWatchStoreOptions = {},
   ) {
      this.watchTtlMilliseconds = assertPositiveInteger(
         options.watchTtlMilliseconds ?? DEFAULT_WATCH_TTL_MILLISECONDS,
         'watchTtlMilliseconds',
      );
      this.maxOpenWatches = assertPositiveInteger(
         options.maxOpenWatches ?? DEFAULT_MAX_OPEN_WATCHES,
         'maxOpenWatches',
      );
      this.maxOpenWatchesPerPayer = assertPositiveInteger(
         options.maxOpenWatchesPerPayer ?? DEFAULT_MAX_OPEN_WATCHES_PER_PAYER,
         'maxOpenWatchesPerPayer',
      );
      this.workUnitBudget = assertPositiveInteger(
         options.workUnitBudget ?? DEFAULT_WORK_UNIT_BUDGET,
         'workUnitBudget',
      );
      this.readinessProbeIntervalMilliseconds = assertPositiveInteger(
         options.readinessProbeIntervalMilliseconds ??
            DEFAULT_READINESS_PROBE_INTERVAL_MILLISECONDS,
         'readinessProbeIntervalMilliseconds',
      );
      this.now = options.now ?? (() => new Date());

      if (databasePath !== ':memory:') {
         mkdirSync(dirname(databasePath), { recursive: true });
      }

      this.database = new DatabaseSync(databasePath);
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.createWatchTable();
      this.database.exec(`
         CREATE TABLE IF NOT EXISTS roundwatch_readiness_probe (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            checked_at TEXT NOT NULL
         );
      `);

      this.ensureColumn(
         'expected_service_transaction',
         'expected_service_transaction TEXT',
      );
      this.ensureColumn('expected_service_network', 'expected_service_network TEXT');
      this.ensureColumn('expected_service_payer', 'expected_service_payer TEXT');
      this.ensureColumn(
         'settlement_reconciliation_terminal',
         'settlement_reconciliation_terminal INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn('expires_at', 'expires_at TEXT');
      this.ensureColumn('closing_round', 'closing_round INTEGER');
      this.ensureColumn('evidence_version', 'evidence_version INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('service_receiver', 'service_receiver TEXT');
      this.ensureColumn('service_asset_id', 'service_asset_id INTEGER');
      this.ensureColumn('service_atomic_amount', 'service_atomic_amount TEXT');
      this.ensureColumn('service_first_valid', 'service_first_valid INTEGER');
      this.ensureColumn('service_last_valid', 'service_last_valid INTEGER');
      this.ensureColumn('reconciliation_attempts', 'reconciliation_attempts INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('reconciliation_next_attempt_at', 'reconciliation_next_attempt_at TEXT');
      this.ensureColumn('work_unit_budget', 'work_unit_budget INTEGER');
      this.ensureColumn('work_units_used', 'work_units_used INTEGER NOT NULL DEFAULT 0');
      this.ensureColumn('terminal_reason', 'terminal_reason TEXT');
      this.ensureColumn('polling_failure_code', 'polling_failure_code TEXT');
      this.ensureColumn('polling_failure_status', 'polling_failure_status INTEGER');
      this.ensureColumn(
         'polling_failure_disposition',
         'polling_failure_disposition TEXT',
      );
      this.ensureColumn(
         'polling_failure_count',
         'polling_failure_count INTEGER NOT NULL DEFAULT 0',
      );
      this.ensureColumn(
         'polling_last_failure_at',
         'polling_last_failure_at TEXT',
      );
      this.ensureColumn('polling_retry_at', 'polling_retry_at TEXT');
      this.ensureWatchStateConstraint();
      // Create audit tables only after the primary watch schema has finished
      // any rebuild/migration. This prevents foreign-key references from being
      // retargeted to a temporary legacy table during ALTER TABLE RENAME.
      this.createRefundAuditTable();

      // Existing rows predate the durable work contract. Give them a fresh
      // conservative budget from migration time instead of leaving an
      // accidentally unbounded obligation after deploy.
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET work_unit_budget = ?
         WHERE work_unit_budget IS NULL
      `).run(this.workUnitBudget);

      this.database.exec(`
         CREATE UNIQUE INDEX IF NOT EXISTS roundwatch_idempotency_scope_unique
         ON roundwatch_watches(
            COALESCE(expected_service_payer, ''),
            idempotency_key
         );

         CREATE UNIQUE INDEX IF NOT EXISTS roundwatch_expected_service_tx_unique
         ON roundwatch_watches(expected_service_transaction)
         WHERE expected_service_transaction IS NOT NULL;

         CREATE INDEX IF NOT EXISTS roundwatch_active_created_idx
         ON roundwatch_watches(state, created_at);

         CREATE INDEX IF NOT EXISTS roundwatch_reconcile_due_idx
         ON roundwatch_watches(
            settlement_reconciliation_terminal,
            reconciliation_next_attempt_at,
            created_at
         )
         WHERE state IN ('settlement_pending', 'settlement_unknown')
           AND expected_service_transaction IS NOT NULL;

         CREATE INDEX IF NOT EXISTS roundwatch_open_payer_idx
         ON roundwatch_watches(
            COALESCE(expected_service_payer, service_payer),
            state,
            settlement_reconciliation_terminal
         );

         CREATE INDEX IF NOT EXISTS roundwatch_polling_due_idx
         ON roundwatch_watches(state, polling_retry_at, created_at)
         WHERE state = 'active';
      `);

      // evidence_version=0 rows are legacy. No new proof fields are fabricated.
   }

   recordSettlementCandidate(
      id: string,
      evidence: SettlementEvidence,
   ): WatchRecord {
      const existing = this.getWatch(id);

      if (!existing) {
         throw new Error(`Cannot record settlement for missing watch ${id}`);
      }

      assertSettlementEvidenceMatches(existing, evidence);

      if (existing.state === 'active' || existing.state === 'matched') {
         if (existing.serviceTransaction === evidence.transaction) {
            return existing;
         }

         throw new Error(`Watch ${id} was already activated by another settlement`);
      }

      if (
         existing.state !== 'settlement_pending' &&
         existing.state !== 'settlement_unknown'
      ) {
         throw new Error(`Watch ${id} cannot record settlement while ${existing.state}`);
      }

      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            expected_service_transaction = COALESCE(expected_service_transaction, ?),
            expected_service_network = COALESCE(expected_service_network, ?),
            expected_service_payer = COALESCE(expected_service_payer, ?)
         WHERE id = ?
           AND state IN ('settlement_pending', 'settlement_unknown')
           AND settlement_reconciliation_terminal = 0
      `).run(
         evidence.transaction,
         evidence.network,
         evidence.payer ?? null,
         id,
      );

      return this.getWatch(id)!;
   }

   prepareWatch(
      spec: WatchSpec,
      settlementIntent?: SettlementIntent,
   ): {
      watch: WatchRecord;
      created: boolean;
   } {
      const now = this.currentTime();
      this.database.exec('BEGIN IMMEDIATE;');

      try {
         const existingRow = this.findIdempotencyRow(
            spec.idempotencyKey,
            settlementIntent?.payer,
         );

         if (existingRow) {
            const existing = mapRow(existingRow);

            // A pre-payer legacy row remains a conservative global reservation,
            // but an incoming verified payer must never be treated as its
            // authorized owner merely because key/specification happen to match.
            if (
               settlementIntent?.payer &&
               existing.expectedServicePayer === undefined
            ) {
               throw new LegacyIdempotencyReservationError();
            }

            if (!watchSpecMatches(existing, spec)) {
               throw new IdempotencyConflictError(existing);
            }

            this.database.exec('COMMIT;');
            return { watch: existing, created: false };
         }

         const globalCount = this.countOpenObligations();

         if (globalCount >= this.maxOpenWatches) {
            throw new WatchCapacityError('global');
         }

         if (settlementIntent?.payer) {
            const payerCount = this.countOpenObligations(settlementIntent.payer);

            if (payerCount >= this.maxOpenWatchesPerPayer) {
               throw new WatchCapacityError('payer');
            }
         }

         const id = randomUUID();
         const createdAt = now.toISOString();
         const expiresAt = this.expiryFrom(now);

         this.database.prepare(`
            INSERT INTO roundwatch_watches (
               id,
               idempotency_key,
               state,
               expected_sender,
               expected_receiver,
               asset_id,
               atomic_amount,
               invoice_note,
               expected_service_transaction,
               expected_service_network,
               expected_service_payer,
               service_receiver,
               service_asset_id,
               service_atomic_amount,
               service_first_valid,
               service_last_valid,
               created_at,
               expires_at,
               evidence_version,
               work_unit_budget,
               work_units_used,
               terminal_reason
            ) VALUES (?, ?, 'settlement_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
         `).run(
            id,
            spec.idempotencyKey,
            spec.expectedSender,
            spec.expectedReceiver,
            spec.assetId,
            spec.atomicAmount,
            spec.invoiceNote ?? null,
            settlementIntent?.expectedTransaction ?? null,
            settlementIntent?.network ?? null,
            settlementIntent?.payer ?? null,
            settlementIntent?.receiver ?? null,
            settlementIntent?.assetId ?? null,
            settlementIntent?.atomicAmount ?? null,
            settlementIntent?.firstValid ?? null,
            settlementIntent?.lastValid ?? null,
            createdAt,
            expiresAt,
            settlementIntent ? 1 : 0,
            this.workUnitBudget,
         );

         const inserted = this.database.prepare(`
            SELECT * FROM roundwatch_watches WHERE id = ?
         `).get(id) as unknown as WatchRow;
         this.database.exec('COMMIT;');

         return {
            watch: mapRow(inserted),
            created: true,
         };
      } catch (error) {
         this.database.exec('ROLLBACK;');
         throw error;
      }
   }

   activateWatch(
      id: string,
      evidence: SettlementEvidence,
      activationRound?: number,
   ): WatchRecord {
      const existing = this.getWatch(id);

      if (!existing) {
         throw new Error(`Cannot activate missing watch ${id}`);
      }

      assertSettlementEvidenceMatches(existing, evidence);

      if (existing.state === 'active' || existing.state === 'matched') {
         if (existing.serviceTransaction === evidence.transaction) {
            return existing;
         }

         throw new Error(`Watch ${id} was already activated by another settlement`);
      }

      if (
         existing.state !== 'settlement_pending' &&
         existing.state !== 'settlement_unknown'
      ) {
         throw new Error(
            `Watch ${id} is ${existing.state}, not settlement_pending or settlement_unknown`,
         );
      }

      const activatedAt = this.currentTime().toISOString();
      const result = this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'active',
            service_transaction = ?,
            service_network = ?,
            service_payer = ?,
            activation_round = ?,
            activated_at = ?,
            scan_after_round = ?
         WHERE id = ?
           AND state IN ('settlement_pending', 'settlement_unknown')
           AND settlement_reconciliation_terminal = 0
      `).run(
         evidence.transaction,
         evidence.network,
         evidence.payer ?? null,
         activationRound ?? null,
         activatedAt,
         activationRound ?? null,
         id,
      );

      if (result.changes !== 1) {
         throw new Error(`Watch ${id} activation lost a state race`);
      }

      return this.getWatch(id)!;
   }

   markSettlementUnknown(id: string): void {
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'settlement_unknown',
            settlement_reconciliation_terminal = 0
         WHERE id = ? AND state = 'settlement_pending'
      `).run(id);
   }

   markSettlementInvalid(id: string): void {
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'settlement_unknown',
            settlement_reconciliation_terminal = 1
         WHERE id = ?
           AND state IN ('settlement_pending', 'settlement_unknown')
      `).run(id);
   }

   claimWorkUnit(
      id: string,
   ): 'claimed' | 'exhausted' | 'inactive' {
      const claimed = this.database.prepare(`
         UPDATE roundwatch_watches
         SET work_units_used = work_units_used + 1
         WHERE id = ?
           AND state IN ('settlement_pending', 'settlement_unknown', 'active')
           AND work_unit_budget IS NOT NULL
           AND work_units_used < work_unit_budget
      `).run(id);

      if (claimed.changes === 1) {
         return 'claimed';
      }

      const watch = this.getWatch(id);
      if (
         !watch ||
         !['settlement_pending', 'settlement_unknown', 'active'].includes(
            watch.state,
         )
      ) {
         return 'inactive';
      }

      if (
         watch.workUnitBudget !== undefined &&
         watch.workUnitsUsed >= watch.workUnitBudget
      ) {
         const exhausted = this.database.prepare(`
            UPDATE roundwatch_watches
            SET
               state = 'indeterminate',
               terminal_reason = 'work_budget_exhausted',
               settlement_reconciliation_terminal = 1
            WHERE id = ?
              AND state IN ('settlement_pending', 'settlement_unknown', 'active')
              AND work_unit_budget IS NOT NULL
              AND work_units_used >= work_unit_budget
         `).run(id);

         return exhausted.changes === 1 ? 'exhausted' : 'inactive';
      }

      return 'inactive';
   }

   recordPollingFailure(
      id: string,
      failure: PollingFailure,
   ): WatchRecord | undefined {
      if (!/^[a-z0-9_]{1,64}$/.test(failure.code)) {
         throw new Error(
            'polling failure code must be a stable lowercase identifier',
         );
      }

      if (
         failure.status !== undefined &&
         (!Number.isSafeInteger(failure.status) ||
            failure.status < 100 ||
            failure.status > 599)
      ) {
         throw new Error(
            'polling failure status must be a valid HTTP status',
         );
      }

      if (
         failure.disposition !== 'permanent' &&
         failure.disposition !== 'transient' &&
         failure.disposition !== 'unknown'
      ) {
         throw new Error('polling failure disposition is invalid');
      }

      const failedAt = this.currentTime();
      let retryAt: string | null = null;

      if (failure.disposition !== 'permanent') {
         if (
            !(failure.retryAt instanceof Date) ||
            !Number.isFinite(failure.retryAt.getTime()) ||
            failure.retryAt.getTime() <= failedAt.getTime()
         ) {
            throw new Error(
               'non-permanent polling failure requires a future retryAt',
            );
         }
         retryAt = failure.retryAt.toISOString();
      }

      const result = this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            polling_failure_code = ?,
            polling_failure_status = ?,
            polling_failure_disposition = ?,
            polling_failure_count = polling_failure_count + 1,
            polling_last_failure_at = ?,
            polling_retry_at = ?,
            state = CASE
               WHEN ? = 'permanent' THEN 'indeterminate'
               ELSE state
            END,
            terminal_reason = CASE
               WHEN ? = 'permanent' THEN 'indexer_permanent_failure'
               ELSE terminal_reason
            END
         WHERE id = ? AND state = 'active'
      `).run(
         failure.code,
         failure.status ?? null,
         failure.disposition,
         failedAt.toISOString(),
         retryAt,
         failure.disposition,
         failure.disposition,
         id,
      );

      return result.changes === 1 ? this.getWatch(id) : undefined;
   }

   clearPollingFailure(id: string): void {
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            polling_failure_code = NULL,
            polling_failure_status = NULL,
            polling_failure_disposition = NULL,
            polling_failure_count = 0,
            polling_last_failure_at = NULL,
            polling_retry_at = NULL
         WHERE id = ? AND state = 'active'
      `).run(id);
   }

   markMatched(
      id: string,
      transaction: string,
      round: number,
   ): WatchRecord | undefined {
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'matched',
            matched_transaction = ?,
            matched_round = ?
         WHERE id = ?
           AND state = 'active'
      `).run(transaction, round, id);

      return this.getWatch(id);
   }

   advanceScanRound(id: string, expectedRound: number, round: number): boolean {
      if (!Number.isSafeInteger(round) || round <= expectedRound) return false;
      const result = this.database.prepare(`
         UPDATE roundwatch_watches SET scan_after_round = ?
         WHERE id = ? AND state = 'active' AND scan_after_round = ? AND ? > scan_after_round
      `).run(round, id, expectedRound, round);
      return result.changes === 1;
   }

   getWatch(id: string): WatchRecord | undefined {
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches WHERE id = ?
      `).get(id) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   // Diagnostic/legacy helper. New request paths should use the payer-scoped
   // lookup because idempotency keys are no longer globally unique.
   getByIdempotencyKey(idempotencyKey: string): WatchRecord | undefined {
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE idempotency_key = ?
         ORDER BY created_at ASC
         LIMIT 1
      `).get(idempotencyKey) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   getByPayerAndIdempotencyKey(
      payer: string,
      idempotencyKey: string,
   ): WatchRecord | undefined {
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE expected_service_payer = ?
           AND idempotency_key = ?
         LIMIT 1
      `).get(payer, idempotencyKey) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   listActiveWatches(): WatchRecord[] {
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE state = 'active'
         ORDER BY created_at ASC
      `).all() as unknown as WatchRow[];

      return rows.map(mapRow);
   }

   listPollingCandidates(): WatchRecord[] {
      const now = this.currentTime().toISOString();
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE state = 'active'
           AND (polling_retry_at IS NULL OR polling_retry_at <= ?)
         ORDER BY created_at ASC
      `).all(now) as unknown as WatchRow[];

      return rows.map(mapRow);
   }

   listSettlementReconciliationCandidates(): WatchRecord[] {
      const now = this.currentTime().toISOString();
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE state IN ('settlement_pending', 'settlement_unknown')
           AND expected_service_transaction IS NOT NULL
           AND settlement_reconciliation_terminal = 0
           AND (reconciliation_next_attempt_at IS NULL OR reconciliation_next_attempt_at <= ?)
         ORDER BY COALESCE(reconciliation_next_attempt_at, created_at), created_at ASC
      `).all(now) as unknown as WatchRow[];

      return rows.map(mapRow);
   }

   setClosingRound(id: string, round: number): number | undefined {
      this.database.prepare(`UPDATE roundwatch_watches SET closing_round = COALESCE(closing_round, ?)
         WHERE id = ? AND state = 'active' AND evidence_version = 1`).run(round, id);
      return this.getWatch(id)?.closingRound;
   }

   markExpired(id: string, expectedScanRound: number, closingRound: number): boolean {
      const result = this.database.prepare(`UPDATE roundwatch_watches SET state = 'expired'
         WHERE id = ? AND state = 'active' AND evidence_version = 1
           AND scan_after_round = ? AND closing_round = ? AND scan_after_round >= closing_round
      `).run(id, expectedScanRound, closingRound);
      return result.changes === 1;
   }

   recordReconciliationFailure(id: string, nextAttemptAt: Date): void {
      this.database.prepare(`UPDATE roundwatch_watches
         SET reconciliation_attempts = reconciliation_attempts + 1,
             reconciliation_next_attempt_at = ?
         WHERE id = ? AND settlement_reconciliation_terminal = 0
      `).run(nextAttemptAt.toISOString(), id);
   }
   recordRefundEvidence(
      watchId: string,
      evidence: RefundEvidence,
   ): RefundRecord {
      if (!this.getWatch(watchId)) {
         throw new Error(`Cannot record refund for missing watch ${watchId}`);
      }
      assertRefundEvidence(evidence);

      const existing = this.database.prepare(`
         SELECT * FROM roundwatch_refunds
         WHERE transaction_id = ?
      `).get(evidence.transaction) as unknown as RefundRow | undefined;

      if (existing) {
         const mapped = mapRefundRow(existing);
         if (
            mapped.watchId !== watchId ||
            mapped.network !== evidence.network ||
            mapped.atomicAmount !== evidence.atomicAmount ||
            (mapped.reason ?? undefined) !== (evidence.reason ?? undefined)
         ) {
            throw new Error(
               'Refund transaction is already bound to different audit evidence',
            );
         }
         return mapped;
      }

      const recordedAt = this.currentTime().toISOString();
      const result = this.database.prepare(`
         INSERT INTO roundwatch_refunds (
            watch_id,
            transaction_id,
            network,
            atomic_amount,
            reason,
            recorded_at
         ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
         watchId,
         evidence.transaction,
         evidence.network,
         evidence.atomicAmount,
         evidence.reason ?? null,
         recordedAt,
      );

      const row = this.database.prepare(`
         SELECT * FROM roundwatch_refunds WHERE id = ?
      `).get(Number(result.lastInsertRowid)) as unknown as RefundRow;

      return mapRefundRow(row);
   }

   listRefundEvidence(watchId: string): RefundRecord[] {
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_refunds
         WHERE watch_id = ?
         ORDER BY recorded_at ASC, id ASC
      `).all(watchId) as unknown as RefundRow[];

      return rows.map(mapRefundRow);
   }


   configuredWorkUnitBudget(): number {
      return this.workUnitBudget;
   }

   configuredWatchTtlMilliseconds(): number {
      return this.watchTtlMilliseconds;
   }

   readinessCheck(force = false): boolean {
      if (this.closed) return false;

      const now = Date.now();
      if (
         !force &&
         now - this.lastReadinessProbeAt <
            this.readinessProbeIntervalMilliseconds
      ) {
         return this.lastReadinessProbeResult;
      }

      const result = probeSqliteWriteReadiness(
         this.database,
         new Date(now).toISOString(),
      );
      this.lastReadinessProbeAt = now;
      this.lastReadinessProbeResult = result;
      return result;
   }

   close(): void {
      this.closed = true;
      this.lastReadinessProbeResult = false;
      this.database.close();
   }

   private countOpenObligations(payer?: string): number {
      const payerClause = payer
         ? 'AND COALESCE(expected_service_payer, service_payer) = ?'
         : '';
      const row = this.database.prepare(`
         SELECT COUNT(*) AS count
         FROM roundwatch_watches
         WHERE (
            state IN ('settlement_pending', 'active')
            OR (
               state = 'settlement_unknown'
               AND settlement_reconciliation_terminal = 0
            )
         )
         ${payerClause}
      `).get(...(payer ? [payer] : [])) as unknown as { count: number };

      return row.count;
   }

   private createWatchTable(): void {
      this.database.exec(`
         CREATE TABLE IF NOT EXISTS roundwatch_watches (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL,
            state TEXT NOT NULL CHECK (
               state IN (
                  'settlement_pending',
                  'active',
                  'matched',
                  'settlement_unknown',
                  'expired',
                  'indeterminate'
               )
            ),
            expected_sender TEXT NOT NULL,
            expected_receiver TEXT NOT NULL,
            asset_id INTEGER NOT NULL,
            atomic_amount TEXT NOT NULL,
            invoice_note TEXT,
            expected_service_transaction TEXT,
            expected_service_network TEXT,
            expected_service_payer TEXT,
            service_transaction TEXT UNIQUE,
            service_network TEXT,
            service_payer TEXT,
            activation_round INTEGER,
            activated_at TEXT,
            scan_after_round INTEGER,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            matched_transaction TEXT,
            matched_round INTEGER,
            settlement_reconciliation_terminal INTEGER NOT NULL DEFAULT 0,
            closing_round INTEGER,
            evidence_version INTEGER NOT NULL DEFAULT 0,
            service_receiver TEXT,
            service_asset_id INTEGER,
            service_atomic_amount TEXT,
            service_first_valid INTEGER,
            service_last_valid INTEGER,
            reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
            reconciliation_next_attempt_at TEXT,
            work_unit_budget INTEGER,
            work_units_used INTEGER NOT NULL DEFAULT 0,
            terminal_reason TEXT,
            polling_failure_code TEXT,
            polling_failure_status INTEGER,
            polling_failure_disposition TEXT,
            polling_failure_count INTEGER NOT NULL DEFAULT 0,
            polling_last_failure_at TEXT,
            polling_retry_at TEXT
         );
      `);
   }

   private ensureWatchStateConstraint(): void {
      const schema = this.database.prepare(`
         SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'roundwatch_watches'
      `).get() as unknown as { sql?: string } | undefined;

      const hasCurrentStates =
         schema?.sql?.includes("'expired'") &&
         schema.sql.includes("'indeterminate'");
      const hasGlobalIdempotencyUnique =
         /idempotency_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(
            schema?.sql ?? '',
         );

      if (hasCurrentStates && !hasGlobalIdempotencyUnique) {
         return;
      }

      this.database.exec('BEGIN IMMEDIATE;');

      try {
         this.database.exec(`
            ALTER TABLE roundwatch_watches RENAME TO roundwatch_watches_legacy;
         `);
         this.createWatchTable();
         this.database.exec(`
            INSERT INTO roundwatch_watches (
               id,
               idempotency_key,
               state,
               expected_sender,
               expected_receiver,
               asset_id,
               atomic_amount,
               invoice_note,
               expected_service_transaction,
               expected_service_network,
               expected_service_payer,
               service_transaction,
               service_network,
               service_payer,
               activation_round,
               activated_at,
               scan_after_round,
               created_at,
               expires_at,
               matched_transaction,
               matched_round,
               settlement_reconciliation_terminal,
               closing_round,
               evidence_version,
               service_receiver,
               service_asset_id,
               service_atomic_amount,
               service_first_valid,
               service_last_valid,
               reconciliation_attempts,
               reconciliation_next_attempt_at,
               work_unit_budget,
               work_units_used,
               terminal_reason,
               polling_failure_code,
               polling_failure_status,
               polling_failure_disposition,
               polling_failure_count,
               polling_last_failure_at,
               polling_retry_at
            )
            SELECT
               id,
               idempotency_key,
               state,
               expected_sender,
               expected_receiver,
               asset_id,
               atomic_amount,
               invoice_note,
               expected_service_transaction,
               expected_service_network,
               expected_service_payer,
               service_transaction,
               service_network,
               service_payer,
               activation_round,
               activated_at,
               scan_after_round,
               created_at,
               expires_at,
               matched_transaction,
               matched_round,
               settlement_reconciliation_terminal,
               closing_round,
               evidence_version,
               service_receiver,
               service_asset_id,
               service_atomic_amount,
               service_first_valid,
               service_last_valid,
               reconciliation_attempts,
               reconciliation_next_attempt_at,
               work_unit_budget,
               work_units_used,
               terminal_reason,
               polling_failure_code,
               polling_failure_status,
               polling_failure_disposition,
               polling_failure_count,
               polling_last_failure_at,
               polling_retry_at
            FROM roundwatch_watches_legacy;

            DROP TABLE roundwatch_watches_legacy;
         `);
         this.database.exec('COMMIT;');
      } catch (error) {
         this.database.exec('ROLLBACK;');
         throw error;
      }
   }

   private findIdempotencyRow(
      idempotencyKey: string,
      payer?: string,
   ): WatchRow | undefined {
      if (!payer) {
         return this.database.prepare(`
            SELECT * FROM roundwatch_watches
            WHERE expected_service_payer IS NULL
              AND idempotency_key = ?
            ORDER BY created_at ASC
            LIMIT 1
         `).get(idempotencyKey) as unknown as WatchRow | undefined;
      }

      // Exact payer scope is authoritative. A legacy row with no persisted
      // payer remains a conservative global reservation until it is explicitly
      // resolved/migrated with trustworthy payer evidence.
      return this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE idempotency_key = ?
           AND (
              expected_service_payer = ?
              OR expected_service_payer IS NULL
           )
         ORDER BY
            CASE WHEN expected_service_payer = ? THEN 0 ELSE 1 END,
            created_at ASC
         LIMIT 1
      `).get(
         idempotencyKey,
         payer,
         payer,
      ) as unknown as WatchRow | undefined;
   }
   private createRefundAuditTable(): void {
      this.database.exec(`
         CREATE TABLE IF NOT EXISTS roundwatch_refunds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            watch_id TEXT NOT NULL,
            transaction_id TEXT NOT NULL UNIQUE,
            network TEXT NOT NULL,
            atomic_amount TEXT NOT NULL,
            reason TEXT,
            recorded_at TEXT NOT NULL,
            FOREIGN KEY (watch_id) REFERENCES roundwatch_watches(id)
         );

         CREATE INDEX IF NOT EXISTS roundwatch_refunds_watch_idx
         ON roundwatch_refunds(watch_id, recorded_at);
      `);
   }


   private currentTime(): Date {
      const now = this.now();

      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
         throw new Error('RoundWatch clock returned an invalid date');
      }

      return now;
   }

   private expiryFrom(createdAt: Date): string {
      const expiresAt = new Date(
         createdAt.getTime() + this.watchTtlMilliseconds,
      );

      if (!Number.isFinite(expiresAt.getTime())) {
         throw new Error('Configured RoundWatch watch TTL exceeds the date range');
      }

      return expiresAt.toISOString();
   }

   private ensureColumn(name: string, definition: string): void {
      const columns = this.database.prepare(
         'PRAGMA table_info(roundwatch_watches)',
      ).all() as unknown as Array<{ name: string }>;

      if (!columns.some(column => column.name === name)) {
         this.database.exec(
            `ALTER TABLE roundwatch_watches ADD COLUMN ${definition};`,
         );
      }
   }
}

function watchSpecMatches(
   watch: WatchRecord,
   spec: WatchSpec,
): boolean {
   return (
      watch.expectedSender === spec.expectedSender &&
      watch.expectedReceiver === spec.expectedReceiver &&
      watch.assetId === spec.assetId &&
      watch.atomicAmount === spec.atomicAmount &&
      (watch.invoiceNote ?? undefined) === (spec.invoiceNote ?? undefined)
   );
}

function assertSettlementEvidenceMatches(
   watch: WatchRecord,
   evidence: SettlementEvidence,
): void {
   if (
      watch.expectedServiceTransaction &&
      watch.expectedServiceTransaction !== evidence.transaction
   ) {
      throw new Error(
         `Watch ${watch.id} settlement transaction does not match the prepared payment`,
      );
   }

   if (
      watch.expectedServiceNetwork &&
      watch.expectedServiceNetwork !== evidence.network
   ) {
      throw new Error(
         `Watch ${watch.id} settlement network does not match the prepared payment`,
      );
   }

   if (
      watch.expectedServicePayer &&
      evidence.payer &&
      watch.expectedServicePayer !== evidence.payer
   ) {
      throw new Error(
         `Watch ${watch.id} settlement payer does not match the prepared payment`,
      );
   }
}

function mapRow(row: WatchRow): WatchRecord {
   return {
      id: row.id,
      idempotencyKey: row.idempotency_key,
      state: row.state,
      expectedSender: row.expected_sender,
      expectedReceiver: row.expected_receiver,
      assetId: row.asset_id,
      atomicAmount: row.atomic_amount,
      ...(row.invoice_note === null ? {} : { invoiceNote: row.invoice_note }),
      ...(row.expected_service_transaction === null
         ? {}
         : { expectedServiceTransaction: row.expected_service_transaction }),
      ...(row.expected_service_network === null
         ? {}
         : { expectedServiceNetwork: row.expected_service_network }),
      ...(row.expected_service_payer === null
         ? {}
         : { expectedServicePayer: row.expected_service_payer }),
      ...(row.service_transaction === null
         ? {}
         : { serviceTransaction: row.service_transaction }),
      ...(row.service_network === null
         ? {}
         : { serviceNetwork: row.service_network }),
      ...(row.service_payer === null ? {} : { servicePayer: row.service_payer }),
      ...(row.activation_round === null
         ? {}
         : { activationRound: row.activation_round }),
      ...(row.activated_at === null ? {} : { activatedAt: row.activated_at }),
      ...(row.scan_after_round === null
         ? {}
         : { scanAfterRound: row.scan_after_round }),
      createdAt: row.created_at,
      ...(row.expires_at === null ? {} : { expiresAt: row.expires_at }),
      ...(row.matched_transaction === null
         ? {}
         : { matchedTransaction: row.matched_transaction }),
      ...(row.matched_round === null ? {} : { matchedRound: row.matched_round }),
      ...(row.closing_round === null ? {} : { closingRound: row.closing_round }),
      evidenceVersion: row.evidence_version,
      ...(row.service_receiver === null ? {} : { serviceReceiver: row.service_receiver }),
      ...(row.service_asset_id === null ? {} : { serviceAssetId: row.service_asset_id }),
      ...(row.service_atomic_amount === null ? {} : { serviceAtomicAmount: row.service_atomic_amount }),
      ...(row.service_first_valid === null ? {} : { serviceFirstValid: row.service_first_valid }),
      ...(row.service_last_valid === null ? {} : { serviceLastValid: row.service_last_valid }),
      reconciliationAttempts: row.reconciliation_attempts,
      ...(row.reconciliation_next_attempt_at === null ? {} : { reconciliationNextAttemptAt: row.reconciliation_next_attempt_at }),
      settlementReconciliationTerminal:
         row.settlement_reconciliation_terminal === 1,
      ...(row.work_unit_budget === null ? {} : { workUnitBudget: row.work_unit_budget }),
      workUnitsUsed: row.work_units_used,
      ...(row.terminal_reason === null ? {} : { terminalReason: row.terminal_reason }),
      ...(row.polling_failure_code === null
         ? {}
         : { pollingFailureCode: row.polling_failure_code }),
      ...(row.polling_failure_status === null
         ? {}
         : { pollingFailureStatus: row.polling_failure_status }),
      ...(row.polling_failure_disposition === null
         ? {}
         : { pollingFailureDisposition: row.polling_failure_disposition }),
      pollingFailureCount: row.polling_failure_count,
      ...(row.polling_last_failure_at === null
         ? {}
         : { pollingLastFailureAt: row.polling_last_failure_at }),
      ...(row.polling_retry_at === null
         ? {}
         : { pollingRetryAt: row.polling_retry_at }),
   };
}
function assertRefundEvidence(evidence: RefundEvidence): void {
   if (
      typeof evidence.transaction !== 'string' ||
      evidence.transaction.length < 1 ||
      evidence.transaction.length > 128
   ) {
      throw new Error('refund transaction must be a 1-128 character identifier');
   }
   if (
      typeof evidence.network !== 'string' ||
      evidence.network.length < 1 ||
      evidence.network.length > 128
   ) {
      throw new Error('refund network must be a 1-128 character identifier');
   }
   if (!/^[1-9]\d*$/.test(evidence.atomicAmount)) {
      throw new Error('refund atomicAmount must be a positive integer string');
   }
   if (
      evidence.reason !== undefined &&
      (evidence.reason.length < 1 ||
         Buffer.byteLength(evidence.reason, 'utf8') > 256)
   ) {
      throw new Error('refund reason must be 1-256 UTF-8 bytes when supplied');
   }
}

function mapRefundRow(row: RefundRow): RefundRecord {
   return {
      id: row.id,
      watchId: row.watch_id,
      transaction: row.transaction_id,
      network: row.network,
      atomicAmount: row.atomic_amount,
      ...(row.reason === null ? {} : { reason: row.reason }),
      recordedAt: row.recorded_at,
   };
}


export function probeSqliteWriteReadiness(
   database: DatabaseSync,
   checkedAt: string,
): boolean {
   let transactionOpen = false;

   try {
      database.exec('BEGIN IMMEDIATE;');
      transactionOpen = true;
      database.prepare(`
         INSERT INTO roundwatch_readiness_probe (id, checked_at)
         VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET checked_at = excluded.checked_at
      `).run(checkedAt);
      database.exec('ROLLBACK;');
      transactionOpen = false;
      return true;
   } catch {
      if (transactionOpen) {
         try {
            database.exec('ROLLBACK;');
         } catch {
            // The connection may already be unusable. Readiness remains false.
         }
      }
      return false;
   }
}

function assertPositiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive integer`);
   }

   return value;
}
