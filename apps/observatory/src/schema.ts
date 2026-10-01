export const PARSER_VERSION = 'observatory-parser-v1' as const;
export const REPORT_VERSION = 1 as const;
export const SOURCE_ARTIFACT_VERSION = 1 as const;
export const OBSERVED_SERVICE_VERSION = 1 as const;

export type Diagnostic =
   | 'valid_non_empty'
   | 'valid_empty'
   | 'unsupported_envelope'
   | 'malformed_payload';

export interface LocatedValue {
   locator: string;
   value: string;
}

export interface PaymentOfferV1 {
   locator: string;
   scheme: string | null;
   rawNetwork: string | null;
   interpretedNetwork: 'algorand-mainnet' | 'algorand-testnet' | null;
   asset: string | null;
   assetLocator: string | null;
   atomicAmount: string | null;
   payee: string | null;
   warnings: string[];
   unknownFields: string[];
}

export interface ObservedServiceV1 {
   schemaVersion: typeof OBSERVED_SERVICE_VERSION;
   artifactId: string;
   locator: string;
   sourceRecordId: string | null;
   resourceIdentifiers: LocatedValue[];
   httpMethod: string | null;
   mcpTool: string | null;
   descriptions: LocatedValue[];
   sourceTimestamps: LocatedValue[];
   paymentOffers: PaymentOfferV1[];
   warnings: string[];
   unknownFields: string[];
}

export interface SourceArtifactV1 {
   schemaVersion: typeof SOURCE_ARTIFACT_VERSION;
   artifactId: string;
   sha256: string;
   captureTimestamp: string | null;
   sourceDescription: string | null;
   sourceUrl: string | null;
   warnings: string[];
}

export interface ObservatoryReportV1 {
   schemaVersion: typeof REPORT_VERSION;
   parserVersion: typeof PARSER_VERSION;
   diagnostic: Diagnostic;
   sourceArtifact: SourceArtifactV1;
   envelopeLocator: string | null;
   records: ObservedServiceV1[];
   warnings: string[];
}
