import {
   USDC_MAINNET_ASA_ID,
   USDC_TESTNET_ASA_ID,
} from '@x402/avm';

export type RoundWatchNetworkName = 'testnet' | 'mainnet';

import { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from '../algorand-networks.js';
export { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2 } from '../algorand-networks.js';

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

export function resolveRoundWatchPublicBaseUrl(
   value: string | undefined,
   networkName: RoundWatchNetworkName,
): string | undefined {
   const configured = value?.trim();

   if (!configured) {
      if (networkName === 'mainnet') {
         throw new Error('ROUNDWATCH_PUBLIC_BASE_URL is required on MainNet');
      }

      return undefined;
   }

   let url: URL;

   try {
      url = new URL(configured);
   } catch {
      throw new Error('ROUNDWATCH_PUBLIC_BASE_URL must be a valid absolute URL');
   }

   if (url.username || url.password || url.search || url.hash) {
      throw new Error(
         'ROUNDWATCH_PUBLIC_BASE_URL must not contain credentials, a query, or a fragment',
      );
   }

   if (networkName === 'mainnet') {
      if (url.protocol !== 'https:') {
         throw new Error('ROUNDWATCH_PUBLIC_BASE_URL must use HTTPS on MainNet');
      }

      if (isLoopbackHostname(url.hostname)) {
         throw new Error(
            'ROUNDWATCH_PUBLIC_BASE_URL must not use localhost or a loopback address on MainNet',
         );
      }
   }

   return url.toString().replace(/\/+$/, '');
}

function isLoopbackHostname(hostname: string): boolean {
   const normalized = hostname.toLowerCase().replace(/\.$/, '');

   return (
      normalized === 'localhost' ||
      normalized.endsWith('.localhost') ||
      normalized === '0.0.0.0' ||
      normalized === '::1' ||
      normalized === '[::1]' ||
      normalized.startsWith('[::ffff:127.') ||
      normalized.startsWith('127.')
   );
}
