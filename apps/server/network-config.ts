import {
   USDC_MAINNET_ASA_ID,
   USDC_TESTNET_ASA_ID,
} from '@x402/avm';

export type RoundWatchNetworkName = 'testnet' | 'mainnet';

// GoPlausible currently advertises the full Algorand genesis-hash CAIP-2 IDs.
// Keep these explicit instead of relying on SDK constants whose shortened values
// are not accepted by the hosted facilitator during /supported synchronization.
export const ALGORAND_TESTNET_CAIP2 =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;
export const ALGORAND_MAINNET_CAIP2 =
   'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;

export interface RoundWatchNetworkConfig {
   name: RoundWatchNetworkName;
   network: typeof ALGORAND_TESTNET_CAIP2 | typeof ALGORAND_MAINNET_CAIP2;
   usdcAssetId: string;
   usdcAssetIdNumber: number;
   indexerUrl: string;
   challengeTag: string;
}

export const TESTNET_NETWORK_CONFIG: RoundWatchNetworkConfig = {
   name: 'testnet',
   network: ALGORAND_TESTNET_CAIP2,
   usdcAssetId: USDC_TESTNET_ASA_ID,
   usdcAssetIdNumber: Number(USDC_TESTNET_ASA_ID),
   indexerUrl: 'https://testnet-idx.algonode.cloud',
   challengeTag: 'roundwatch-spike-0',
};

export const MAINNET_NETWORK_CONFIG: RoundWatchNetworkConfig = {
   name: 'mainnet',
   network: ALGORAND_MAINNET_CAIP2,
   usdcAssetId: USDC_MAINNET_ASA_ID,
   usdcAssetIdNumber: Number(USDC_MAINNET_ASA_ID),
   indexerUrl: 'https://mainnet-idx.algonode.cloud',
   challengeTag: 'x402-global-challenge',
};

export function resolveRoundWatchNetwork(
   value: string | undefined,
): RoundWatchNetworkConfig {
   const normalized = value?.trim().toLowerCase() || 'testnet';

   if (normalized === 'testnet') {
      return TESTNET_NETWORK_CONFIG;
   }

   if (normalized === 'mainnet') {
      return MAINNET_NETWORK_CONFIG;
   }

   throw new Error(
      `ROUNDWATCH_NETWORK must be "testnet" or "mainnet", received ${JSON.stringify(value)}`,
   );
}
