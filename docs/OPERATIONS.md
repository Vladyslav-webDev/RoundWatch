# RoundWatch operations runbook

RoundWatch is a single-instance service whose paid obligations and scan progress
are stored in SQLite. Operational mistakes around that file can be as damaging
as application bugs because the database is part of the service's payment
evidence.

## Production readiness

Use the endpoints for different purposes:

- `GET /health` is liveness only. It proves that the HTTP process can answer.
- `GET /ready` is the paid-traffic readiness signal. It checks durable storage
  and that the in-process poller/reconciler have started.

After every deployment, require `/ready` to return HTTP 200 before directing
new paid watch creation traffic. A healthy-but-not-ready process must not be
treated as ready for paid obligations.

Routine production smoke tests should be free: liveness, readiness, an unpaid
watch request that returns HTTP 402, and reads of already-known watch IDs.
Do not create a paid MainNet watch merely to test deployment health.

## SQLite location and WAL files

MainNet requires an explicit absolute `ROUNDWATCH_DB_PATH`. The current Render
deployment uses `/data/roundwatch.sqlite` on persistent storage.

SQLite runs in WAL mode. While the service is running, the database can have
three relevant files:

- `roundwatch.sqlite`
- `roundwatch.sqlite-wal`
- `roundwatch.sqlite-shm`

Do not make a "backup" by copying only the main `.sqlite` file from a live
service. Use a SQLite-consistent online backup/snapshot mechanism, or stop the
service cleanly and preserve the complete database state. A backup process that
silently drops live WAL contents is not acceptable for paid obligations.

## Backup policy

For the challenge-release deployment:

1. take a consistent backup before any storage migration or destructive
   maintenance;
2. keep backup material outside the live persistent volume;
3. record the backup creation time and the deployed Git commit;
4. validate the backup before relying on it;
5. never place wallet mnemonics, private keys, or client `.env` files in the
   backup set.

A backup is considered validated only after a restore drill opens the copied
database successfully and SQLite reports no integrity errors.

## Restore drill

Perform restore drills on a copy, never on the live production database.

1. stop any process that could write to the restore target;
2. restore the consistent SQLite snapshot into an isolated path;
3. run SQLite integrity validation, including `PRAGMA integrity_check;`;
4. start RoundWatch against the isolated copy with external paid traffic
   disabled;
5. verify that representative active and terminal watches can be read;
6. verify that reconciliation and polling start without schema or state errors;
7. only then treat the backup procedure as tested.

Restoring a stale backup can lose obligations created after the snapshot and can
rewind scan progress. Rewound scan progress is conservative because it causes
re-scanning, but missing post-backup paid obligations cannot be reconstructed
from SQLite alone. Treat restore timing and customer reconciliation as an
incident, not as an ordinary restart.

## Disk and database growth

The service does not currently implement automatic row deletion. Monitor the
persistent volume for free space and database growth. A full disk can prevent
durable writes even while the HTTP process remains alive.

The current challenge-release retention policy is therefore explicit but
conservative: terminal watch records are retained until deliberate operator
maintenance. There is no public deletion API. Watch metadata must not be used as
a secret store, and invoice notes must not contain confidential or personal
data.

A finite commercial retention/deletion policy is a product requirement before
RoundWatch is presented as a general-purpose long-lived service.

## Deployment checks

After a deploy:

1. confirm the expected Git commit is running;
2. verify `GET /health` returns HTTP 200 and identifies liveness;
3. verify `GET /ready` returns HTTP 200;
4. make an unpaid `POST /v1/watch` and confirm HTTP 402 without settlement;
5. read an existing known watch and confirm `Cache-Control: no-store`;
6. review logs for storage, reconciliation, Indexer, or startup warnings.

If `/health` is 200 but `/ready` is 503, do not direct new paid traffic to the
instance.

## Incident rules

- Do not manually force a watch into `active`, `matched`, or `expired`.
- Do not delete a checkpoint or database row simply to make a retry succeed.
- Do not replay or synthesize MainNet payments to manufacture health evidence.
- Preserve logs, the deployed commit, the database snapshot, and the affected
  watch IDs before destructive maintenance.
- Treat repeated `settlement_unknown`, Indexer validation failures, disk-full
  errors, or integrity failures as incidents requiring investigation.
