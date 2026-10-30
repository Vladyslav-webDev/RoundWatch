// Network aliases are explicit identities, never a prefix/truncation heuristic.
// Emit canonical CAIP-2 for new offers; retain legacy strings in durable records.
export const ALGORAND_MAINNET_CAIP2 =
   'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k' as const;
export const ALGORAND_TESTNET_CAIP2 =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe' as const;
export const LEGACY_ALGORAND_MAINNET =
   'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=' as const;
export const LEGACY_ALGORAND_TESTNET =
   'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=' as const;

function canonicalNetwork(network: unknown): string | undefined {
   switch (network) {
      case ALGORAND_MAINNET_CAIP2:
      case LEGACY_ALGORAND_MAINNET:
         return ALGORAND_MAINNET_CAIP2;
      case ALGORAND_TESTNET_CAIP2:
      case LEGACY_ALGORAND_TESTNET:
         return ALGORAND_TESTNET_CAIP2;
      default:
         return undefined;
   }
}

// Use only at settlement/checkpoint compatibility boundaries. Unknown identifiers
// (including identical unknown strings) are deliberately not equivalent.
export function sameAlgorandNetwork(left: unknown, right: unknown): boolean {
   const canonical = canonicalNetwork(left);
   return canonical !== undefined && canonical === canonicalNetwork(right);
}
