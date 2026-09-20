import algosdk from 'algosdk';

const MAX_TXN_BYTES_PER_BLOCK = 5_242_880;
const MIN_TXN_FEE_MICROALGOS = 1_000n;
const MAINNET_USDC_ASSET_ID = 31_566_704n;

// Current MainNet rounds are far above 2^16 and far below 2^32. Using a
// representative round in that range preserves the MsgPack integer width that
// matters for encoded-size analysis without requiring a network request.
const REPRESENTATIVE_MAINNET_ROUND = 65_000_000n;

interface ProbeCase {
   name: string;
   note?: Uint8Array;
}

const cases: ProbeCase[] = [
   { name: 'no-note' },
   { name: 'one-byte-note', note: new TextEncoder().encode('x') },
   {
      name: 'roundwatch-style-note',
      note: new TextEncoder().encode(
         'roundwatch:invoice-2026-09-20-001',
      ),
   },
   { name: 'max-roundwatch-note', note: new Uint8Array(128).fill(0x78) },
];

const sender = algosdk.generateAccount();
const receiver = algosdk.generateAccount();

const suggestedParams = {
   flatFee: true,
   fee: MIN_TXN_FEE_MICROALGOS,
   minFee: MIN_TXN_FEE_MICROALGOS,
   firstValid: REPRESENTATIVE_MAINNET_ROUND,
   lastValid: REPRESENTATIVE_MAINNET_ROUND,
   // MainNet requires a genesis hash. SignedTxnInBlock removes it again
   // because the block header already carries the same hash.
   genesisHash: new Uint8Array(32).fill(1),
};

console.log('RoundWatch collision transaction size probe');
console.log(
   `block transaction budget: ${MAX_TXN_BYTES_PER_BLOCK} bytes`,
);
console.log(
   `minimum normal transaction fee: ${MIN_TXN_FEE_MICROALGOS} microAlgo`,
);
console.log(
   'SignedTxnInBlock model: standard Ed25519 signature, empty ApplyData, genesis hash stripped by block encoding.',
);

for (const probeCase of cases) {
   const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
      sender: sender.addr,
      receiver: receiver.addr,
      amount: 1n,
      assetIndex: MAINNET_USDC_ASSET_ID,
      ...(probeCase.note ? { note: probeCase.note } : {}),
      suggestedParams,
   });

   const unsignedBytes = algosdk.encodeUnsignedTransaction(txn);
   const signedBytes = txn.signTxn(sender.sk);
   const blockBytes = encodeCurrentProtocolSignedTxnInBlock(signedBytes);

   const maxPerBlock = Math.floor(
      MAX_TXN_BYTES_PER_BLOCK / blockBytes.length,
   );
   const minimumFeesPerFullBlockMicroAlgo =
      BigInt(maxPerBlock) * MIN_TXN_FEE_MICROALGOS;

   console.log(
      'TX_SIZE_RESULT ' +
         JSON.stringify({
            case: probeCase.name,
            noteBytes: probeCase.note?.length ?? 0,
            unsignedWireBytes: unsignedBytes.length,
            signedWireBytes: signedBytes.length,
            signedTxnInBlockBytes: blockBytes.length,
            maxPerFullBlock: maxPerBlock,
            minimumFeesPerFullBlockMicroAlgo:
               minimumFeesPerFullBlockMicroAlgo.toString(),
            minimumFeesPerFullBlockAlgo:
               Number(minimumFeesPerFullBlockMicroAlgo) / 1_000_000,
            maxCandidatesPer100Rounds: maxPerBlock * 100,
            maxIndexerPagesPer100Rounds: Math.ceil(
               (maxPerBlock * 100) / 1_000,
            ),
         }),
   );
}

function encodeCurrentProtocolSignedTxnInBlock(
   signedBytes: Uint8Array,
): Uint8Array {
   const decoded = algosdk.decodeObj(signedBytes);
   const signed = requireRecord(decoded, 'signed transaction');
   const transaction = requireRecord(
      signed.txn,
      'signed transaction txn',
   );

   // Current Algorand block encoding (SignedTxnInBlock) strips the required
   // genesis hash when it matches the block header. Empty ApplyData and false
   // hgi/hgh flags are omitted by canonical MsgPack encoding.
   const blockTransaction = {
      ...signed,
      txn: {
         ...transaction,
      },
   };
   delete blockTransaction.txn.gh;

   return algosdk.encodeObj(blockTransaction);
}

function requireRecord(
   value: unknown,
   label: string,
): Record<string, unknown> {
   if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`${label} did not decode to an object`);
   }

   return value as Record<string, unknown>;
}
