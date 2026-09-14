import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type WatchState =
   | 'settlement_pending'
   | 'active'
   | 'matched'
   | 'settlement_unknown';

export interface WatchSpec {
   idempotencyKey: string;
   expectedSender: string;
   expectedReceiver: string;
   assetId: number;
   atomicAmount: string;
   invoiceNote?: string;
}

export interface WatchRecord extends WatchSpec {
   id: string;
   state: WatchState;
   serviceTransaction?: string;
   serviceNetwork?: string;
   servicePayer?: string;
   activationRound?: number;
   activatedAt?: string;
   scanAfterRound?: number;
   createdAt: string;
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
   service_transaction: string | null;
   service_network: string | null;
   service_payer: string | null;
   activation_round: number | null;
   activated_at: string | null;
   scan_after_round: number | null;
   created_at: string;
   matched_transaction: string | null;
   matched_round: number | null;
}

export class RoundWatchStore {
   private readonly database: DatabaseSync;

   constructor(databasePath: string) {
      if (databasePath !== ':memory:') {
         mkdirSync(dirname(databasePath), { recursive: true });
      }

      this.database = new DatabaseSync(databasePath);
      this.database.exec('PRAGMA journal_mode = WAL;');
      this.database.exec('PRAGMA foreign_keys = ON;');
      this.database.exec(`
         CREATE TABLE IF NOT EXISTS roundwatch_watches (
            id TEXT PRIMARY KEY,
            idempotency_key TEXT NOT NULL UNIQUE,
            state TEXT NOT NULL CHECK (
               state IN (
                  'settlement_pending',
                  'active',
                  'matched',
                  'settlement_unknown'
               )
            ),
            expected_sender TEXT NOT NULL,
            expected_receiver TEXT NOT NULL,
            asset_id INTEGER NOT NULL,
            atomic_amount TEXT NOT NULL,
            invoice_note TEXT,
            service_transaction TEXT UNIQUE,
            service_network TEXT,
            service_payer TEXT,
            activation_round INTEGER,
            activated_at TEXT,
            scan_after_round INTEGER,
            created_at TEXT NOT NULL,
            matched_transaction TEXT,
            matched_round INTEGER
         );
      `);
   }

   prepareWatch(spec: WatchSpec): {
      watch: WatchRecord;
      created: boolean;
   } {
      const existing = this.getByIdempotencyKey(spec.idempotencyKey);

      if (existing) {
         return { watch: existing, created: false };
      }

      const id = randomUUID();
      const createdAt = new Date().toISOString();

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
            created_at
         ) VALUES (?, ?, 'settlement_pending', ?, ?, ?, ?, ?, ?)
      `).run(
         id,
         spec.idempotencyKey,
         spec.expectedSender,
         spec.expectedReceiver,
         spec.assetId,
         spec.atomicAmount,
         spec.invoiceNote ?? null,
         createdAt,
      );

      return {
         watch: this.getWatch(id)!,
         created: true,
      };
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

      if (existing.state === 'active' || existing.state === 'matched') {
         if (existing.serviceTransaction === evidence.transaction) {
            return existing;
         }

         throw new Error(`Watch ${id} was already activated by another settlement`);
      }

      if (existing.state !== 'settlement_pending') {
         throw new Error(`Watch ${id} is ${existing.state}, not settlement_pending`);
      }

      const activatedAt = new Date().toISOString();
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
         WHERE id = ? AND state = 'settlement_pending'
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
         SET state = 'settlement_unknown'
         WHERE id = ? AND state = 'settlement_pending'
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
            matched_round = ?,
            scan_after_round = ?
         WHERE id = ? AND state = 'active'
      `).run(transaction, round, round, id);

      return this.getWatch(id);
   }

   advanceScanRound(id: string, round: number): void {
      this.database.prepare(`
         UPDATE roundwatch_watches
         SET scan_after_round = ?
         WHERE id = ? AND state = 'active'
      `).run(round, id);
   }

   getWatch(id: string): WatchRecord | undefined {
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches WHERE id = ?
      `).get(id) as unknown as WatchRow | undefined;

      return row ? mapRow(row) : undefined;
   }

   getByIdempotencyKey(idempotencyKey: string): WatchRecord | undefined {
      const row = this.database.prepare(`
         SELECT * FROM roundwatch_watches WHERE idempotency_key = ?
      `).get(idempotencyKey) as unknown as WatchRow | undefined;

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

   close(): void {
      this.database.close();
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
      ...(row.matched_transaction === null
         ? {}
         : { matchedTransaction: row.matched_transaction }),
      ...(row.matched_round === null ? {} : { matchedRound: row.matched_round }),
   };
}
