import { BrandMark, Icon } from "./graphics";

const API_BASE = "https://roundwatch-api.onrender.com";
const REPOSITORY = "https://github.com/Vladyslav-webDev/x402-challenge";
const EXAMPLE_SENDER = "3YFZ47IAKPB4H6B7U6MXI35HCAB5E6DA47UANIHOON53J7I5SMXUSYQXQQ";
const EXAMPLE_RECEIVER = "EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY";

function QuickstartBrand() {
  return (
    <a className="quickstart-brand" href="/" aria-label="RoundWatch home">
      <BrandMark orbital />
      <span>RoundWatch</span>
    </a>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="quickstart-code">
      <code>{children}</code>
    </pre>
  );
}

export default function QuickstartPage() {
  const requestBody = `{
  "idempotencyKey": "invoice-2026-09-17-001",
  "expectedSender": "${EXAMPLE_SENDER}",
  "expectedReceiver": "${EXAMPLE_RECEIVER}",
  "atomicAmount": "1",
  "invoiceNote": "roundwatch:invoice-2026-09-17-001"
}`;

  const unpaidRequest = `curl -i -X POST ${API_BASE}/v1/watch \\
  -H "content-type: application/json" \\
  --data '{"idempotencyKey":"invoice-2026-09-17-001","expectedSender":"${EXAMPLE_SENDER}","expectedReceiver":"${EXAMPLE_RECEIVER}","atomicAmount":"1","invoiceNote":"roundwatch:invoice-2026-09-17-001"}'`;

  const statusRequest = `curl -sS ${API_BASE}/v1/watch/YOUR_WATCH_ID`;

  return (
    <div className="quickstart-site">
      <header className="quickstart-header container">
        <QuickstartBrand />
        <nav aria-label="Quickstart navigation">
          <a href="/">Product</a>
          <a href={`${REPOSITORY}#readme`}>Docs</a>
          <a href={`${REPOSITORY}/blob/main/docs/MAINNET_READINESS.md`}>
            MainNet proof
          </a>
        </nav>
      </header>

      <main className="quickstart-main container">
        <section className="quickstart-hero">
          <p className="eyebrow">Quickstart / MainNet</p>
          <h1>
            Start in 60 seconds.
            <br />
            <span>Create the watch. Let RoundWatch own the wait.</span>
          </h1>
          <p className="quickstart-lede">
            RoundWatch watches one exact future Algorand USDC payment. Your caller
            can create the obligation, complete the x402 service payment, save the
            returned watch ID, and exit. RoundWatch persists the state and returns
            the matching transaction later.
          </p>
          <div className="quickstart-facts mono">
            <span>Algorand MainNet</span>
            <span>USDC ASA 31566704</span>
            <span>0.02 USDC service fee</span>
            <span>30 minute eligibility deadline</span>
          </div>
        </section>

        <section className="quickstart-grid" aria-label="RoundWatch quickstart steps">
          <article className="quickstart-step">
            <span className="quickstart-step-number mono">01</span>
            <div>
              <h2>Define the exact payment</h2>
              <p>
                Send the expected sender, receiver, atomic amount, and optional
                invoice note. The watched asset is server-selected MainNet USDC,
                not a caller-controlled field. The addresses below are valid public
                example addresses from the verified MainNet proof.
              </p>
              <CodeBlock>{requestBody}</CodeBlock>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">02</span>
            <div>
              <h2>Inspect the 402 before paying</h2>
              <p>
                An ordinary request returns <code>402 Payment Required</code>. This
                is a free preflight. No payment is sent until an x402-capable client
                signs and retries the same request.
              </p>
              <CodeBlock>{unpaidRequest}</CodeBlock>
              <p className="quickstart-note">
                Before a paid MainNet retry, verify the advertised network, asset,
                amount, receiver, and resource URL. The guarded reference client in
                this repository performs those checks before it can spend.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">03</span>
            <div>
              <h2>Settle with an x402-capable client</h2>
              <p>
                Wallet signing stays in the client process. RoundWatch does not need
                your mnemonic or private key. The repository includes a guarded
                MainNet reference flow using <code>@x402/fetch</code> and
                <code>@x402/avm</code>.
              </p>
              <div className="quickstart-links">
                <a href={`${REPOSITORY}/blob/main/apps/client/mainnet-e2e.ts`}>
                  View guarded MainNet client <Icon name="arrow" />
                </a>
                <a href={`${REPOSITORY}/blob/main/README.md#x402-payment-and-recovery`}>
                  Read payment & recovery docs <Icon name="arrow" />
                </a>
              </div>
              <p className="quickstart-warning mono">
                MainNet spends real USDC. Use TestNet while integrating unless you
                deliberately intend to pay on MainNet.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">04</span>
            <div>
              <h2>Save the watch ID and leave</h2>
              <p>
                A successful paid request returns a durable <code>watchId</code>.
                RoundWatch confirms the exact service-payment transaction, uses its
                confirmed round as the activation baseline, persists the scan cursor,
                and owns the waiting obligation after your process exits.
              </p>
              <CodeBlock>{`{
  "watchId": "f5d2fb6f-b224-4aae-989c-87a5418fd2ae",
  "message": "The watch is returned only if x402 settlement and durable activation succeed"
}`}</CodeBlock>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">05</span>
            <div>
              <h2>Read the result later</h2>
              <p>
                Poll the public status endpoint whenever your workflow returns. A
                matched watch exposes the exact Algorand transaction ID and confirmed
                round that satisfied the watch. Passing the 30-minute deadline does not
                itself produce <code>expired</code>; terminal expiry requires complete
                indexed coverage through a fixed closing checkpoint. If the
                durable 500-turn work budget is exhausted before a match or complete
                expiry proof, the terminal state is <code>indeterminate</code>, not
                <code>expired</code>.
              </p>
              <CodeBlock>{statusRequest}</CodeBlock>
              <div className="quickstart-states mono" aria-label="Watch states">
                <span>settlement_pending</span>
                <span>active</span>
                <span>matched</span>
                <span>settlement_unknown</span>
                <span>expired</span>
                <span>indeterminate</span>
              </div>
            </div>
          </article>
        </section>

        <section className="quickstart-contract">
          <div>
            <p className="eyebrow">Current operating limits</p>
            <h2>Bounded by design.</h2>
          </div>
          <dl>
            <div>
              <dt>API</dt>
              <dd>{API_BASE}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>Algorand MainNet</dd>
            </div>
            <div>
              <dt>Service fee</dt>
              <dd>0.02 USDC</dd>
            </div>
            <div>
              <dt>Eligibility deadline</dt>
              <dd>30 minutes from durable creation; expiry is proof-based</dd>
            </div>
            <div>
              <dt>Work budget</dt>
              <dd>500 durable background turns; exhaustion → indeterminate</dd>
            </div>
            <div>
              <dt>Open capacity</dt>
              <dd>50 global / 5 per verified service payer</dd>
            </div>
            <div>
              <dt>Status privacy</dt>
              <dd>Anyone who knows a watch ID can query its public record</dd>
            </div>
          </dl>
        </section>

        <section className="quickstart-docs">
          <p className="eyebrow">Go deeper</p>
          <h2>Implementation, proof, and trust boundaries.</h2>
          <div className="quickstart-doc-grid">
            <a href={`${REPOSITORY}/blob/main/README.md`}>
              <span>README</span>
              <small>API contract and local development</small>
            </a>
            <a href={`${REPOSITORY}/blob/main/docs/ARCHITECTURE.md`}>
              <span>Architecture</span>
              <small>Normal, recovery, and matching paths</small>
            </a>
            <a href={`${REPOSITORY}/blob/main/docs/SECURITY.md`}>
              <span>Security</span>
              <small>Signer boundary and operational assumptions</small>
            </a>
            <a href={`${REPOSITORY}/blob/main/docs/MAINNET_READINESS.md`}>
              <span>MainNet evidence</span>
              <small>Verified settlement and matched payment proof</small>
            </a>
          </div>
        </section>

        <section className="quickstart-final">
          <div>
            <p className="eyebrow">Ready to inspect the product?</p>
            <h2>See the lifecycle before you integrate it.</h2>
          </div>
          <div className="button-row">
            <a className="button button-primary" href="/#video-demo">
              <span>See the demo</span>
              <Icon name="arrow" />
            </a>
            <a className="button button-secondary" href={REPOSITORY}>
              <span>Open GitHub</span>
              <Icon name="arrow" />
            </a>
          </div>
        </section>
      </main>

      <footer className="quickstart-footer container mono">
        <span>© 2026 RoundWatch</span>
        <a href="/">Back to product</a>
      </footer>
    </div>
  );
}