import { isAbsolute, resolve } from 'node:path';

import { config } from 'dotenv';
import { createAdaptorServer, type ServerType } from '@hono/node-server';
import { isValidAlgorandAddress } from '@x402/avm';

import { createAppRuntime } from './app.js';
import { ApplicationLifetime } from './roundwatch-application-lifetime.js';
import { createRoundWatchHttpFetch } from './roundwatch-observatory-transport.js';
import { RoundWatchFacilitatorClient } from './roundwatch-facilitator.js';
import {
   closeNodeServer,
   createShutdownCoordinator,
   parseShutdownDeadline,
   type BackgroundShutdownOwner,
} from './roundwatch-shutdown-coordinator.js';
import { installShutdownSignals, startProductionRuntime } from './roundwatch-startup.js';
import {
   resolveRoundWatchNetwork,
   resolveRoundWatchPublicBaseUrl,
} from './network-config.js';
import {
   AlgorandIndexerClient,
   resolveScanQueryVariant,
} from './roundwatch-indexer.js';
import { RoundWatchEconomicsMetrics } from './roundwatch-metrics.js';
import {
   DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS,
   DEFAULT_INDEXER_IDLE_HEALTH_PROBE_INTERVAL_MS,
   DEFAULT_PAID_ADMISSION_INDEXER_EVIDENCE_MAX_AGE_MS,
   IndexerHealthProbe,
} from './roundwatch-health-probe.js';
import {
   DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS,
} from './roundwatch-runtime-metrics.js';
import { RoundWatchPoller } from './roundwatch-poller.js';
import { createObservatoryRuntimeSnapshotBuilder } from './roundwatch-observatory-runtime.js';
import {
   initializeObservatorySampleRetention,
   initializeObservatoryReadinessRetention,
   createObservatoryRuntimeSampler,
} from './roundwatch-observatory-initialization.js';
import { SettlementReconciler } from './roundwatch-reconciler.js';
import { createPaidAdmissionReadinessCheck } from './roundwatch-paid-readiness.js';
import {
   DEFAULT_SIGNED_PAYMENT_BURST,
   DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
   DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
} from './free-payment-gate.js';
import {
   DEFAULT_INDEXER_BURST,
   DEFAULT_INDEXER_CONCURRENCY,
   DEFAULT_INDEXER_REQUESTS_PER_SECOND,
   IndexerRequestDispatcher,
} from './roundwatch-scheduler.js';
import {
   DEFAULT_SCAN_PAGE_CACHE_BYTES,
   DEFAULT_SCAN_PAGE_CACHE_ENTRIES,
   DEFAULT_SCAN_ROUND_WINDOW,
} from './roundwatch-poller.js';
import { maxBackgroundIndexerRequestsForWorkBudget } from './roundwatch-work-budget.js';
import {
   DEFAULT_MIN_FREE_DISK_BYTES,
   hasDatabaseDiskHeadroom,
} from './roundwatch-readiness.js';
import {
   DEFAULT_MAX_OPEN_WATCHES,
   DEFAULT_MAX_OPEN_WATCHES_PER_PAYER,
   DEFAULT_WATCH_TTL_MILLISECONDS,
   DEFAULT_WORK_UNIT_BUDGET,
   RoundWatchStore,
   type SettlementEvidence,
   type WatchRecord,
} from './roundwatch-store.js';

config();

class TestnetExitAfterSettleStore extends RoundWatchStore {
   override activateWatch(
      _id: string,
      evidence: SettlementEvidence,
      _activationRound?: number,
   ): WatchRecord {
      console.error(
         `INTENTIONAL TESTNET FAULT: settlement ${evidence.transaction} succeeded; exiting before SQLite activation commit`,
      );
      process.exit(86);
   }
}

const avmAddress = process.env.AVM_ADDRESS?.trim();
const facilitatorUrl = process.env.FACILITATOR_URL?.trim();

if (!avmAddress || !facilitatorUrl) {
   console.error(
      'Missing environment variables: AVM_ADDRESS or FACILITATOR_URL',
   );
   process.exit(1);
}

if (!isValidAlgorandAddress(avmAddress)) {
   console.error('AVM_ADDRESS is not a valid Algorand address');
   process.exit(1);
}

let networkConfig;
let publicBaseUrl;
let watchTtlMilliseconds;
let maxOpenWatches;
let maxOpenWatchesPerPayer;
let workUnitBudget;
let backgroundIndexerRequestCeiling;
let indexerRequestsPerSecond;
let indexerBurst;
let indexerConcurrency;
let scanRoundWindow;
let scanPageCacheEntries;
let scanPageCacheBytes;
let economicsSampleIntervalMilliseconds;
let scanQueryVariant;
let signedPaymentRequestsPerSecond;
let signedPaymentBurst;
let signedPaymentConcurrency;
let minimumFreeDiskBytes;
let indexerIdleProbeIntervalMilliseconds;
let paidAdmissionProbeMaxAgeMilliseconds;
let shutdownDeadlineMilliseconds;

try {
   shutdownDeadlineMilliseconds = parseShutdownDeadline(process.env.ROUNDWATCH_SHUTDOWN_DEADLINE_MS);
   networkConfig = resolveRoundWatchNetwork(process.env.ROUNDWATCH_NETWORK);
   publicBaseUrl = resolveRoundWatchPublicBaseUrl(
      process.env.ROUNDWATCH_PUBLIC_BASE_URL,
      networkConfig.name,
   );
   watchTtlMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_WATCH_TTL_MS,
      DEFAULT_WATCH_TTL_MILLISECONDS,
      'ROUNDWATCH_WATCH_TTL_MS',
   );
   maxOpenWatches = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_MAX_OPEN_WATCHES,
      DEFAULT_MAX_OPEN_WATCHES,
      'ROUNDWATCH_MAX_OPEN_WATCHES',
   );
   maxOpenWatchesPerPayer = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_MAX_OPEN_WATCHES_PER_PAYER,
      DEFAULT_MAX_OPEN_WATCHES_PER_PAYER,
      'ROUNDWATCH_MAX_OPEN_WATCHES_PER_PAYER',
   );
   workUnitBudget = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_WORK_UNIT_BUDGET,
      DEFAULT_WORK_UNIT_BUDGET,
      'ROUNDWATCH_WORK_UNIT_BUDGET',
   );
   backgroundIndexerRequestCeiling =
      maxBackgroundIndexerRequestsForWorkBudget(workUnitBudget);
   indexerRequestsPerSecond = parseRequiredPositiveNumber(
      process.env.ROUNDWATCH_INDEXER_REQUESTS_PER_SECOND,
      DEFAULT_INDEXER_REQUESTS_PER_SECOND,
      'ROUNDWATCH_INDEXER_REQUESTS_PER_SECOND',
   );
   indexerBurst = parseRequiredPositiveInteger(process.env.ROUNDWATCH_INDEXER_BURST, DEFAULT_INDEXER_BURST, 'ROUNDWATCH_INDEXER_BURST');
   indexerConcurrency = parseRequiredPositiveInteger(process.env.ROUNDWATCH_INDEXER_CONCURRENCY, DEFAULT_INDEXER_CONCURRENCY, 'ROUNDWATCH_INDEXER_CONCURRENCY');
   scanRoundWindow = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SCAN_ROUND_WINDOW,
      DEFAULT_SCAN_ROUND_WINDOW,
      'ROUNDWATCH_SCAN_ROUND_WINDOW',
   );
   scanPageCacheEntries = parseRequiredNonNegativeInteger(
      process.env.ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES,
      DEFAULT_SCAN_PAGE_CACHE_ENTRIES,
      'ROUNDWATCH_SCAN_PAGE_CACHE_ENTRIES',
   );
   scanPageCacheBytes = parseRequiredNonNegativeInteger(
      process.env.ROUNDWATCH_SCAN_PAGE_CACHE_BYTES,
      DEFAULT_SCAN_PAGE_CACHE_BYTES,
      'ROUNDWATCH_SCAN_PAGE_CACHE_BYTES',
   );
   economicsSampleIntervalMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_ECONOMICS_SAMPLE_INTERVAL_MS,
      DEFAULT_ECONOMICS_SAMPLE_INTERVAL_MS,
      'ROUNDWATCH_ECONOMICS_SAMPLE_INTERVAL_MS',
   );
   scanQueryVariant = resolveScanQueryVariant(
      process.env.ROUNDWATCH_SCAN_QUERY_VARIANT,
   );
   signedPaymentRequestsPerSecond = parseRequiredPositiveNumber(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
      DEFAULT_SIGNED_PAYMENT_REQUESTS_PER_SECOND,
      'ROUNDWATCH_SIGNED_PAYMENT_REQUESTS_PER_SECOND',
   );
   signedPaymentBurst = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_BURST,
      DEFAULT_SIGNED_PAYMENT_BURST,
      'ROUNDWATCH_SIGNED_PAYMENT_BURST',
   );
   signedPaymentConcurrency = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_SIGNED_PAYMENT_CONCURRENCY,
      DEFAULT_SIGNED_PAYMENT_CONCURRENCY,
      'ROUNDWATCH_SIGNED_PAYMENT_CONCURRENCY',
   );
   minimumFreeDiskBytes = parseRequiredNonNegativeInteger(
      process.env.ROUNDWATCH_MIN_FREE_DISK_BYTES,
      DEFAULT_MIN_FREE_DISK_BYTES,
      'ROUNDWATCH_MIN_FREE_DISK_BYTES',
   );
   indexerIdleProbeIntervalMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_INDEXER_IDLE_PROBE_INTERVAL_MS,
      DEFAULT_INDEXER_IDLE_HEALTH_PROBE_INTERVAL_MS,
      'ROUNDWATCH_INDEXER_IDLE_PROBE_INTERVAL_MS',
   );
   paidAdmissionProbeMaxAgeMilliseconds = parseRequiredPositiveInteger(
      process.env.ROUNDWATCH_PAID_ADMISSION_PROBE_MAX_AGE_MS,
      DEFAULT_PAID_ADMISSION_INDEXER_EVIDENCE_MAX_AGE_MS,
      'ROUNDWATCH_PAID_ADMISSION_PROBE_MAX_AGE_MS',
   );
   if (
      indexerIdleProbeIntervalMilliseconds <
      DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS
   ) {
      throw new Error(
         'ROUNDWATCH_INDEXER_IDLE_PROBE_INTERVAL_MS must be at least the active 15000 ms probe interval',
      );
   }
   if (
      paidAdmissionProbeMaxAgeMilliseconds <
      DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS
   ) {
      throw new Error(
         'ROUNDWATCH_PAID_ADMISSION_PROBE_MAX_AGE_MS must be at least the active 15000 ms probe interval',
      );
   }
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
}

const faultExitAfterSettle =
   process.env.ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE?.trim() === '1';
const economicsInstrumentationEnabled =
   process.env.ROUNDWATCH_ECONOMICS_METRICS?.trim() === '1';
// Captured once; optional transport validates silently and fails closed.
const observatoryToken = process.env.ROUNDWATCH_OBSERVATORY_TOKEN;

if (faultExitAfterSettle && networkConfig.name !== 'testnet') {
   console.error(
      'ROUNDWATCH_TESTNET_EXIT_AFTER_SETTLE is a TestNet-only fault-injection switch and is forbidden on MainNet',
   );
   process.exit(1);
}

const configuredDatabasePath = process.env.ROUNDWATCH_DB_PATH?.trim();

if (networkConfig.name === 'mainnet' && !configuredDatabasePath) {
   console.error(
      'ROUNDWATCH_DB_PATH must be explicitly configured for MainNet so durable state is not written to an accidental ephemeral path',
   );
   process.exit(1);
}

if (
   networkConfig.name === 'mainnet' &&
   configuredDatabasePath &&
   !isAbsolute(configuredDatabasePath)
) {
   console.error(
      'ROUNDWATCH_DB_PATH must be an absolute path on MainNet and should point at a mounted persistent volume',
   );
   process.exit(1);
}

const databasePath = resolve(
   configuredDatabasePath || 'data/roundwatch.sqlite',
);
const indexerUrl =
   process.env.ALGORAND_INDEXER_URL?.trim() || networkConfig.indexerUrl;
const pollIntervalMilliseconds = parsePositiveInteger(
   process.env.ROUNDWATCH_POLL_INTERVAL_MS,
   5_000,
);
const reconciliationIntervalMilliseconds = parsePositiveInteger(
   process.env.ROUNDWATCH_RECONCILE_INTERVAL_MS,
   5_000,
);

try {
   assertUrlSafety(facilitatorUrl, 'FACILITATOR_URL', networkConfig.name);
   assertUrlSafety(indexerUrl, 'ALGORAND_INDEXER_URL', networkConfig.name);

   if (networkConfig.name === 'mainnet' && /testnet/i.test(indexerUrl)) {
      throw new Error(
         'ALGORAND_INDEXER_URL looks like a TestNet endpoint while ROUNDWATCH_NETWORK=mainnet',
      );
   }
} catch (error) {
   console.error(error instanceof Error ? error.message : error);
   process.exit(1);
}

const facilitatorClient = new RoundWatchFacilitatorClient({
   url: facilitatorUrl,
});
const storeOptions = {
   watchTtlMilliseconds,
   maxOpenWatches,
   maxOpenWatchesPerPayer,
   workUnitBudget,
};
const store = faultExitAfterSettle
   ? new TestnetExitAfterSettleStore(databasePath, storeOptions)
   : new RoundWatchStore(databasePath, storeOptions);
const application = new ApplicationLifetime();
let server: ServerType | undefined;
let runtimeSampler: ReturnType<typeof createObservatoryRuntimeSampler>;
// Register cleanup immediately after SQLite exists, including partial startup.
const background: Partial<Record<'poller' | 'reconciler' | 'healthProbe' | 'dispatcher', BackgroundShutdownOwner>> = {};
function backgroundOwner(name: keyof typeof background): BackgroundShutdownOwner {
   return {
      stopScheduling: () => background[name]?.stopScheduling(),
      drain: () => background[name]?.drain() ?? Promise.resolve(),
   };
}
const coordinator = createShutdownCoordinator({
   application,
   facilitator: facilitatorClient,
   poller: backgroundOwner('poller'),
   reconciler: backgroundOwner('reconciler'),
   healthProbe: backgroundOwner('healthProbe'),
   dispatcher: backgroundOwner('dispatcher'),
   runtimeSampler: { stop: () => runtimeSampler?.stop() },
   closeServer: () => server ? closeNodeServer(server) : Promise.resolve(),
   closeStore: () => { store.close(); console.log('x402 Resource Server CLOSED'); },
   deadlineMs: shutdownDeadlineMilliseconds,
   terminate: code => process.exit(code),
   // Do not serialize transport causes, headers or provider response bodies.
   report: (message, error) => console.error(message, error instanceof Error ? error.name : ''),
});
const setExitCode = (code: number) => { process.exitCode = code; };
installShutdownSignals(process, coordinator, setExitCode);
export let observatoryRuntimeSnapshot: ReturnType<typeof createObservatoryRuntimeSnapshotBuilder> | undefined;

try {
   const dispatcher = new IndexerRequestDispatcher({
      requestsPerSecond: indexerRequestsPerSecond,
      burst: indexerBurst,
      concurrency: indexerConcurrency,
   });
   background.dispatcher = dispatcher;
   const economicsMetrics = economicsInstrumentationEnabled
      ? new RoundWatchEconomicsMetrics()
      : undefined;
   const indexer = new AlgorandIndexerClient(
      indexerUrl,
      dispatcher,
      fetch,
      10_000,
      economicsMetrics,
      scanQueryVariant,
   );
   const healthProbe = new IndexerHealthProbe(
      indexer,
      networkConfig.usdcAssetIdNumber,
      undefined,
      DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS,
      indexerIdleProbeIntervalMilliseconds,
   );
   background.healthProbe = healthProbe;
   const poller = new RoundWatchPoller(
      store,
      indexer,
      pollIntervalMilliseconds,
      scanRoundWindow,
      undefined,
      economicsMetrics,
      scanPageCacheEntries,
      scanPageCacheBytes,
      healthProbe,
   );
   background.poller = poller;
   const reconciler = new SettlementReconciler(
      store,
      indexer,
      {
         network: networkConfig.network,
         intervalMilliseconds: reconciliationIntervalMilliseconds,
      },
      economicsMetrics,
      healthProbe,
   );
   background.reconciler = reconciler;
   const observatorySamples = initializeObservatorySampleRetention();
   const observatoryReadiness = initializeObservatoryReadinessRetention();
   // Boot-scoped memory sources only; constructing these performs no readiness work.
   try {
      observatoryRuntimeSnapshot = createObservatoryRuntimeSnapshotBuilder({
         network: networkConfig.name,
         assetId: networkConfig.usdcAssetId,
         economicsMetricsEnabled: economicsInstrumentationEnabled,
         pollerHealthSnapshot: () => poller.healthSnapshot(),
         reconcilerHealthSnapshot: () => reconciler.healthSnapshot(),
         dispatcherSnapshot: () => dispatcher.snapshot(),
         cachedIndexerTip: () => poller.capacitySnapshot(), // poller memory, never store SQL
         pollCycleSnapshot: () => poller.capacitySnapshot(),
         retainedRuntimeSample: observatorySamples === undefined
            ? undefined : () => observatorySamples!.snapshot(),
         retainedPublicReadiness: observatoryReadiness === undefined
            ? undefined : () => observatoryReadiness.snapshot(),
      });
   } catch {
      // Optional snapshot initialization must not prevent operational startup.
      observatoryRuntimeSnapshot = undefined;
   }

   const currentReadinessSnapshot = () => {
      const storage = store.readinessCheck();
      const pollerHealth = poller.healthSnapshot();
      const reconcilerHealth = reconciler.healthSnapshot();
      const pollerReady = pollerHealth.ready;
      const reconcilerReady = reconcilerHealth.ready;
      const backgroundWorkers = pollerReady && reconcilerReady;
      const diskHeadroom = hasDatabaseDiskHeadroom(
         databasePath,
         minimumFreeDiskBytes,
      );
      const ready = storage && backgroundWorkers && diskHeadroom;
      const checks = {
         storage,
         poller: pollerReady,
         reconciler: reconcilerReady,
         backgroundWorkers,
         diskHeadroom,
      };

      if (!ready) {
         console.warn(JSON.stringify({
            event: 'roundwatch_readiness_blocked',
            timestamp: new Date().toISOString(),
            checks,
            poller: pollerHealth,
            reconciler: reconcilerHealth,
         }));
      }

      return { ready, checks };
   };

   const paidAdmissionReadinessCheck = createPaidAdmissionReadinessCheck({
      storageReady: () => store.readinessCheck(),
      diskHeadroom: () =>
         hasDatabaseDiskHeadroom(databasePath, minimumFreeDiskBytes),
      poller,
      reconciler,
      healthProbe,
      maximumEvidenceAgeMilliseconds: paidAdmissionProbeMaxAgeMilliseconds,
   });

   let appRuntime: ReturnType<typeof createAppRuntime>;
   const initializePayments = () => {
      appRuntime = createAppRuntime({
         avmAddress,
         facilitatorClient,
         store,
         indexer,
         networkConfig,
         publicBaseUrl,
         economicsMetrics,
         signedPaymentGateOptions: {
            requestsPerSecond: signedPaymentRequestsPerSecond,
            burst: signedPaymentBurst,
            concurrency: signedPaymentConcurrency,
         },
         requestTelemetry: {},
         readinessCheck: currentReadinessSnapshot,
         publicReadinessObserver: observatoryReadiness?.observer,
         paidAdmissionReadinessCheck,
      });
      return appRuntime.initializePayments();
   };
   runtimeSampler = createObservatoryRuntimeSampler(
      economicsMetrics,
      dispatcher,
      databasePath,
      observatorySamples,
      {
         intervalMilliseconds: economicsSampleIntervalMilliseconds,
         capacitySnapshot: () => {
            const pollerCapacity = poller.capacitySnapshot();
            return {
               ...store.capacitySnapshot(
                  pollerCapacity.currentIndexerRound,
               ),
               ...pollerCapacity,
            };
         },
      },
   );

   const port = parsePositiveInteger(process.env.PORT, 4021);

   await startProductionRuntime({
      application,
      coordinator,
      initializePayments,
      createServer: () => {
         server = createAdaptorServer({
            fetch: createRoundWatchHttpFetch(application, appRuntime.app.fetch, {
               token: observatoryToken,
               runtimeSnapshot: observatoryRuntimeSnapshot,
            }),
         });
         return server;
      },
      port,
      setExitCode,
      startWorkers: () => {
         reconciler.start();
         if (coordinator.isStopping()) return;
         poller.start();
         if (coordinator.isStopping()) return;
         runtimeSampler?.start();
      },
      onListening: () => {
         console.log(
            `RoundWatch x402 Resource Server listening at http://localhost:${port}`,
         );
         console.log(`Network: ${networkConfig.name}`);
         console.log(`USDC ASA: ${networkConfig.usdcAssetId}`);
         console.log(`Indexer: ${indexerUrl}`);
         console.log(`SQLite: ${databasePath}`);
         console.log(`Watch TTL: ${watchTtlMilliseconds} ms`);
         console.log(
            `Open-watch capacity: ${maxOpenWatches} global / ${maxOpenWatchesPerPayer} per payer`,
         );
         console.log(
            `Durable work budget: ${workUnitBudget} bounded background turns / watch`,
         );
         console.log(
            `Conservative background Indexer ceiling: ${backgroundIndexerRequestCeiling} logical request opportunities / watch`,
         );
         console.log(
            `Signed-payment gate: ${signedPaymentRequestsPerSecond}/s burst=${signedPaymentBurst} concurrency=${signedPaymentConcurrency}`,
         );
         console.log(`Indexer dispatcher: ${indexerRequestsPerSecond}/s burst=${indexerBurst} concurrency=${indexerConcurrency}; scan window=${scanRoundWindow} rounds`);
         console.log(`Indexer scan query variant: ${scanQueryVariant}`);
         console.log(
            `Historical scan-page cache: ${scanPageCacheEntries} entries / ${scanPageCacheBytes} payload bytes`,
         );
         console.log(
            `Readiness disk headroom floor: ${minimumFreeDiskBytes} bytes`,
         );
         console.log(
            `Indexer capability probe: active=${DEFAULT_INDEXER_HEALTH_PROBE_INTERVAL_MS} ms idle=${indexerIdleProbeIntervalMilliseconds} ms paid-max-age=${paidAdmissionProbeMaxAgeMilliseconds} ms`,
         );
         console.log(
            'Request telemetry: enabled (structured JSON; ephemeral HMAC fingerprints)',
         );
         console.log(
            `Economics instrumentation: ${economicsInstrumentationEnabled ? 'enabled' : 'disabled'}`,
         );
         if (economicsInstrumentationEnabled) {
            console.log(
               `Economics sample interval: ${economicsSampleIntervalMilliseconds} ms`,
            );
         }

         if (faultExitAfterSettle) {
            console.warn(
               'TESTNET FAULT INJECTION ARMED: the process will exit after confirmed settlement and before SQLite activation',
            );
         }
      },
   });
} catch (error) {
   const result = await coordinator.shutdown('resource startup failed', error);
   setExitCode(result.exitCode);
}

function assertUrlSafety(
   value: string,
   variableName: string,
   networkName: 'testnet' | 'mainnet',
): void {
   let url: URL;

   try {
      url = new URL(value);
   } catch {
      throw new Error(`${variableName} must be a valid absolute URL`);
   }

   if (networkName === 'mainnet' && url.protocol !== 'https:') {
      throw new Error(`${variableName} must use HTTPS on MainNet`);
   }
}

function parsePositiveInteger(
   value: string | undefined,
   fallback: number,
): number {
   if (!value) {
      return fallback;
   }

   const parsed = Number(value);

   return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRequiredPositiveInteger(
   value: string | undefined,
   fallback: number,
   variableName: string,
): number {
   const parsed = value === undefined || value.trim() === ''
      ? fallback
      : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error(`${variableName} must be a finite positive integer`);
   }

   return parsed;
}

function parseRequiredNonNegativeInteger(
   value: string | undefined,
   fallback: number,
   variableName: string,
): number {
   const parsed = value === undefined || value.trim() === ''
      ? fallback
      : Number(value);

   if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new Error(
         `${variableName} must be a non-negative safe integer`,
      );
   }

   return parsed;
}

function parseRequiredPositiveNumber(value: string | undefined, fallback: number, variableName: string): number {
   const parsed = value === undefined || value.trim() === '' ? fallback : Number(value);
   if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${variableName} must be a finite positive number`);
   return parsed;
}
