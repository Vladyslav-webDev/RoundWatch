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
   'SignedTxnInBlock reconstruction: standard Ed25519 signature, empty ApplyData, no GenesisID, required matching genesis hash stripped by current block encoding.',
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

   assertOwnKey(signed, 'sig', 'standard Ed25519 signature');
   assertOwnKey(signed, 'txn', 'signed transaction');
   rejectOwnKey(signed, 'msig', 'multisignature');
   rejectOwnKey(signed, 'lsig', 'logic signature');
   rejectOwnKey(signed, 'pqsig', 'post-quantum signature');
   rejectOwnKey(signed, 'sgnr', 'auth-address override');
   assertOwnKey(transaction, 'gh', 'required genesis hash');
   rejectOwnKey(transaction, 'gen', 'GenesisID');

   // Source equivalence for the current protocol family:
   // go-algorand BlockHeader.EncodeSignedTxn removes a matching required
   // GenesisHash. RequireGenesisHash has been enabled since v16, so it does
   // not set the hgh compatibility flag. With empty ApplyData and false hgi,
   // the generated SignedTxnInBlock MarshalMsg emits only the standard signed
   // transaction fields ("sig" and "txn"), with the transaction's "gh"
   // omitted. js-algorand-sdk encodeObj uses canonical sorted-key MsgPack.
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


function assertOwnKey(
   object: Record<string, unknown>,
   key: string,
   label: string,
): void {
   if (!Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`Expected ${label} field "${key}" in probe fixture`);
   }
}

function rejectOwnKey(
   object: Record<string, unknown>,
   key: string,
   label: string,
): void {
   if (Object.prototype.hasOwnProperty.call(object, key)) {
      throw new Error(`Unexpected ${label} field "${key}" in probe fixture`);
   }
}
