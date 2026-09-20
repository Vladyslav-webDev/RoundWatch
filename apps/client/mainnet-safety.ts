import { isValidAlgorandAddress } from '@x402/avm';

export const ALGORAND_MAINNET =
   'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;
export const USDC_MAINNET_ASA_ID = 31_566_704;
export const SERVICE_ATOMIC_AMOUNT = '20000';
export const INVOICE_ATOMIC_AMOUNT = '1';
export const MAX_INVOICE_ATOMIC_AMOUNT = 1n;
export const EXPECTED_RECEIVER =
   'EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY';
export const CHALLENGE_TAG = 'x402-global-challenge';
export const DEFAULT_SERVER_URL = 'https://roundwatch-api.onrender.com';
export const DEFAULT_ALGOD_URL = 'https://mainnet-api.algonode.cloud';

export interface MainnetCheckpoint {
   network: typeof ALGORAND_MAINNET;
   assetId: typeof USDC_MAINNET_ASA_ID;
   serverUrl: typeof DEFAULT_SERVER_URL;
   idempotencyKey: string;
   expectedSender: string;
   expectedReceiver: typeof EXPECTED_RECEIVER;
   atomicAmount: typeof INVOICE_ATOMIC_AMOUNT;
   invoiceNote: string;
   watchId?: string;
   serviceSettlementTransaction?: string;
}

export interface MainnetWatchSnapshot {
   id?: string;
   state: string;
   expectedSender?: string;
   expectedReceiver?: string;
   assetId?: number;
   atomicAmount?: string;
   invoiceNote?: string;
   matchedTransaction?: string;
   matchedRound?: number;
}

export interface CheckpointValidationOptions {
   runtimeServerUrl: string;
   payerAddress?: string;
   requireWatchId?: boolean;
   watch?: MainnetWatchSnapshot;
}

export function assertMainnetRuntimeSafety(
   serverUrl: string,
   algodUrl: string,
): void {
   const normalizedServerUrl = normalizeHttpsUrl(serverUrl, 'MainNet server URL');

   if (normalizedServerUrl !== DEFAULT_SERVER_URL) {
      throw new Error(
         `MainNet server URL is not approved for this runner: ${normalizedServerUrl}`,
      );
   }

   normalizeHttpsUrl(algodUrl, 'MainNet Algod URL');
}

export function validateMainnetCheckpoint(
   value: unknown,
   options: CheckpointValidationOptions,
): MainnetCheckpoint {
   if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('MainNet checkpoint must be a JSON object');
   }

   const checkpoint = value as Record<string, unknown>;
   const runtimeServerUrl = normalizeHttpsUrl(
      options.runtimeServerUrl,
      'MainNet server URL',
   );

   if (checkpoint.network !== ALGORAND_MAINNET) {
      throw new Error('MainNet checkpoint network does not match Algorand MainNet');
   }

   if (checkpoint.assetId !== USDC_MAINNET_ASA_ID) {
      throw new Error('MainNet checkpoint asset is not Circle USDC ASA 31566704');
   }

   if (
      checkpoint.serverUrl !== DEFAULT_SERVER_URL ||
      checkpoint.serverUrl !== runtimeServerUrl
   ) {
      throw new Error('MainNet checkpoint server URL does not match the approved runtime URL');
   }

   if (
      typeof checkpoint.expectedSender !== 'string' ||
      !isValidAlgorandAddress(checkpoint.expectedSender)
   ) {
      throw new Error('MainNet checkpoint sender is not a valid Algorand address');
   }

   if (
      options.payerAddress &&
      checkpoint.expectedSender !== options.payerAddress
   ) {
      throw new Error('MainNet checkpoint sender does not match the configured payer');
   }

   if (checkpoint.expectedReceiver !== EXPECTED_RECEIVER) {
      throw new Error('MainNet checkpoint receiver is not the approved RoundWatch receiver');
   }

   if (
      typeof checkpoint.atomicAmount !== 'string' ||
      !/^[1-9]\d*$/.test(checkpoint.atomicAmount) ||
      BigInt(checkpoint.atomicAmount) > MAX_INVOICE_ATOMIC_AMOUNT ||
      checkpoint.atomicAmount !== INVOICE_ATOMIC_AMOUNT
   ) {
      throw new Error('MainNet checkpoint invoice amount exceeds the approved one-unit limit');
   }

   const nonce = parseCheckpointNonce(checkpoint.idempotencyKey, 'mainnet-');

   if (checkpoint.invoiceNote !== `roundwatch:mainnet:${nonce}`) {
      throw new Error('MainNet checkpoint invoice note does not match its idempotency nonce');
   }

   if (
      checkpoint.watchId !== undefined &&
      (typeof checkpoint.watchId !== 'string' || !isUuid(checkpoint.watchId))
   ) {
      throw new Error('MainNet checkpoint watchId is invalid');
   }

   if (options.requireWatchId && !checkpoint.watchId) {
      throw new Error('MainNet checkpoint has no watchId');
   }

   if (options.watch) {
      validateWatchSnapshot(checkpoint, options.watch);
   }

   return checkpoint as unknown as MainnetCheckpoint;
}

function validateWatchSnapshot(
   checkpoint: Record<string, unknown>,
   watch: MainnetWatchSnapshot,
): void {
   if (!checkpoint.watchId || watch.id !== checkpoint.watchId) {
      throw new Error('MainNet watch response does not match the checkpoint watchId');
   }

   if (watch.state !== 'active' && watch.state !== 'matched') {
      throw new Error(`MainNet watch state is not payable: ${watch.state}`);
   }

   const checks: Array<[string, unknown, unknown]> = [
      ['sender', watch.expectedSender, checkpoint.expectedSender],
      ['receiver', watch.expectedReceiver, checkpoint.expectedReceiver],
      ['asset', watch.assetId, checkpoint.assetId],
      ['amount', watch.atomicAmount, checkpoint.atomicAmount],
      ['note', watch.invoiceNote, checkpoint.invoiceNote],
   ];

   for (const [name, actual, expected] of checks) {
      if (actual !== expected) {
         throw new Error(`MainNet watch ${name} does not match the checkpoint`);
      }
   }
}

function parseCheckpointNonce(value: unknown, prefix: string): string {
   if (typeof value !== 'string' || !value.startsWith(prefix)) {
      throw new Error('MainNet checkpoint idempotency key is invalid');
   }

   const nonce = value.slice(prefix.length);

   if (!isUuid(nonce)) {
      throw new Error('MainNet checkpoint idempotency nonce is invalid');
   }

   return nonce;
}

function isUuid(value: string): boolean {
   return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
   );
}

function normalizeHttpsUrl(value: string, label: string): string {
   let url: URL;

   try {
      url = new URL(value);
   } catch {
      throw new Error(`${label} must be an absolute URL`);
   }

   if (url.protocol !== 'https:') {
      throw new Error(`${label} must use HTTPS`);
   }

   if (url.username || url.password || url.search || url.hash) {
      throw new Error(`${label} must not contain credentials, a query, or a fragment`);
   }

   return url.toString().replace(/\/+$/, '');
}
