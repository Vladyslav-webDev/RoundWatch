import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type WatchState =
   | 'settlement_pending'
   | 'active'
   | 'matched'
   | 'settlement_unknown'
   | 'expired';

export const DEFAULT_WATCH_TTL_MILLISECONDS = 30 * 60 * 1_000;
export const DEFAULT_MAX_OPEN_WATCHES = 50;
export const DEFAULT_MAX_OPEN_WATCHES_PER_PAYER = 5;

export interface RoundWatchStoreOptions {
   watchTtlMilliseconds?: number;
   maxOpenWatches?: number;
   maxOpenWatchesPerPayer?: number;
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
}

export interface SettlementEvidence {
   transaction: string;
   network: string;
   payer?: string;
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
}

export class RoundWatchStore {
   private readonly database: DatabaseSync;
   private readonly watchTtlMilliseconds: number;
   private readonly maxOpenWatches: number;
   private readonly maxOpenWatchesPerPayer: number;
   private readonly now: () => Date;

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
      this.now = options.now ?? (() => new Date());

      if (databasePath !== ':memory:') {
         mkdirSync(dirname(databasePath), { recursive: true });
      }

      this.database = new DatabaseSync(databasePath);
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.createWatchTable();

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
      this.ensureExpiredStateConstraint();

      this.database.exec(`
         CREATE UNIQUE INDEX IF NOT EXISTS roundwatch_expected_service_tx_unique
         ON roundwatch_watches(expected_service_transaction)
         WHERE expected_service_transaction IS NOT NULL;
      `);

      // Legacy unfinished obligations receive a full TTL grace period from the
      // first startup on the migrated schema. Terminal historical rows remain
      // unchanged and expose no synthetic expiry.
      const legacyExpiry = this.expiryFrom(this.currentTime());
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET expires_at = ?
         WHERE expires_at IS NULL
           AND (
              state IN ('settlement_pending', 'active')
              OR (
                 state = 'settlement_unknown'
                 AND settlement_reconciliation_terminal = 0
              )
           )
      `).run(legacyExpiry);

      this.expireOpenWatches();
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
      this.expireOpenWatches(now);
      this.database.exec('BEGIN IMMEDIATE;');

      try {
         const existingRow = this.database.prepare(`
            SELECT * FROM roundwatch_watches WHERE idempotency_key = ?
         `).get(spec.idempotencyKey) as unknown as WatchRow | undefined;

         if (existingRow) {
            this.database.exec('COMMIT;');
            return { watch: mapRow(existingRow), created: false };
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
               created_at,
               expires_at
            ) VALUES (?, ?, 'settlement_pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            createdAt,
            expiresAt,
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
           AND (expires_at IS NULL OR expires_at > ?)
      `).run(
         evidence.transaction,
         evidence.network,
         evidence.payer ?? null,
         activationRound ?? null,
         activatedAt,
         activationRound ?? null,
         id,
         activatedAt,
      );

      if (result.changes !== 1) {
         this.expireOpenWatches();
         throw new Error(`Watch ${id} activation lost a state race`);
      }

      return this.getWatch(id)!;
   }

   markSettlementUnknown(id: string): void {
      this.expireOpenWatches();
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'settlement_unknown',
            settlement_reconciliation_terminal = 0
         WHERE id = ? AND state = 'settlement_pending'
      `).run(id);
   }

   markSettlementInvalid(id: string): void {
      this.expireOpenWatches();
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'settlement_unknown',
            settlement_reconciliation_terminal = 1
         WHERE id = ?
           AND state IN ('settlement_pending', 'settlement_unknown')
      `).run(id);
   }

   markMatched(
      id: string,
      transaction: string,
      round: number,
   ): WatchRecord | undefined {
      const now = this.currentTime().toISOString();
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET
            state = 'matched',
            matched_transaction = ?,
            matched_round = ?,
            scan_after_round = ?
         WHERE id = ?
           AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
      `).run(transaction, round, round, id, now);

      this.expireOpenWatches();

      return this.getWatch(id);
   }

   advanceScanRound(id: string, round: number): void {
      const now = this.currentTime().toISOString();
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET scan_after_round = ?
         WHERE id = ?
           AND state = 'active'
           AND (expires_at IS NULL OR expires_at > ?)
      `).run(round, id, now);

      this.expireOpenWatches();
   }

   getWatch(id: string): WatchRecord | undefined {
      this.expireOpenWatches();
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches WHERE id = ?
      `).get(id) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   getByIdempotencyKey(idempotencyKey: string): WatchRecord | undefined {
      this.expireOpenWatches();
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   listActiveWatches(): WatchRecord[] {
      this.expireOpenWatches();
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE state = 'active'
         ORDER BY created_at ASC
      `).all() as unknown as WatchRow[];

      return rows.map(mapRow);
   }

   listSettlementReconciliationCandidates(): WatchRecord[] {
      this.expireOpenWatches();
      const rows = this.database.prepare(`
         SELECT * FROM roundwatch_watches
         WHERE state IN ('settlement_pending', 'settlement_unknown')
           AND expected_service_transaction IS NOT NULL
           AND settlement_reconciliation_terminal = 0
         ORDER BY created_at ASC
      `).all() as unknown as WatchRow[];

      return rows.map(mapRow);
   }

   expireOpenWatches(now = this.currentTime()): number {
      const result = this.database.prepare(`
         UPDATE roundwatch_watches
         SET state = 'expired'
         WHERE expires_at IS NOT NULL
           AND expires_at <= ?
           AND (
              state IN ('settlement_pending', 'active')
              OR (
                 state = 'settlement_unknown'
                 AND settlement_reconciliation_terminal = 0
              )
           )
      `).run(now.toISOString());

      return Number(result.changes);
   }

   close(): void {
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
            idempotency_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (
               state IN (
                  'settlement_pending',
                  'active',
                  'matched',
                  'settlement_unknown',
                  'expired'
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
            settlement_reconciliation_terminal INTEGER NOT NULL DEFAULT 0
         );
      `);
   }

   private ensureExpiredStateConstraint(): void {
      const schema = this.database.prepare(`
         SELECT sql
         FROM sqlite_master
         WHERE type = 'table' AND name = 'roundwatch_watches'
      `).get() as unknown as { sql?: string } | undefined;

      if (schema?.sql?.includes("'expired'")) {
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
               settlement_reconciliation_terminal
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
               settlement_reconciliation_terminal
            FROM roundwatch_watches_legacy;

            DROP TABLE roundwatch_watches_legacy;
         `);
         this.database.exec('COMMIT;');
      } catch (error) {
         this.database.exec('ROLLBACK;');
         throw error;
      }
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
   };
}

function assertPositiveInteger(value: number, name: string): number {
   if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a finite positive integer`);
   }

   return value;
}
