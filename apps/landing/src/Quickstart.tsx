import { BrandMark, Icon } from "./graphics";

const API_BASE = "https://roundwatch-api.onrender.com";
const REPOSITORY = "https://github.com/Vladyslav-webDev/RoundWatch";
const MAINNET_PROOF = `${REPOSITORY}/blob/8384c6ff4b1cc8f8412d5e4ad59f6c8d8b1992a5/docs/POST_REPRICE_CANARY_2026-09-29.md`;
const EXAMPLE_SENDER = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBAKQ4C4";
const EXAMPLE_RECEIVER = "AEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEA5RCDXMI";

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
  "idempotencyKey": "replace-with-unique-idempotency-key",
  "expectedSender": "${EXAMPLE_SENDER}",
  "expectedReceiver": "${EXAMPLE_RECEIVER}",
  "atomicAmount": "1",
  "invoiceNote": "replace-with-unique-invoice-note"
}`;

  const unpaidRequest = `curl -i -X POST ${API_BASE}/v1/watch \\
  -H "content-type: application/json" \\
  --data '{}'`;

  const expectedServiceContract = `x402Version: 2
resource.url: ${API_BASE}/v1/watch
scheme: exact
network: algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k
asset: 31566704
amount: 100000
payTo: EQPLN32HPLPGBCNPOZUL6BL34CTNQGT3VAAMNAJWSIZGQ5CUNXOHB634XY`;

  const statusRequest = `curl -sS ${API_BASE}/v1/watch/YOUR_WATCH_ID`;

  return (
    <div className="quickstart-site">
      <header className="quickstart-header container">
        <QuickstartBrand />
        <nav aria-label="Quickstart navigation">
          <a href="/">Product</a>
          <a href={`${REPOSITORY}#readme`}>Docs</a>
          <a href={MAINNET_PROOF}>Historical MainNet proof</a>
        </nav>
      </header>

      <main className="quickstart-main container">
        <section className="quickstart-hero">
          <p className="eyebrow">Quickstart / MainNet</p>
          <h1>
            Create a watch.
            <br />
            <span>Retrieve the proof later.</span>
          </h1>
          <p className="quickstart-lede">
            RoundWatch watches one exact future Algorand USDC payment. Inspect the
            offer for free, validate the watch and payment terms, then purchase
            the watch with x402. Save the watch ID to retrieve the result later.
          </p>
          <div className="quickstart-facts mono">
            <span>Algorand MainNet</span>
            <span>Circle USDC ASA 31566704</span>
            <span>0.10 USDC service fee</span>
            <span>30-minute eligibility window</span>
          </div>
        </section>

        <section className="quickstart-grid" aria-label="RoundWatch quickstart steps">
          <article className="quickstart-step">
            <span className="quickstart-step-number mono">01</span>
            <div>
              <h2>Define the exact payment</h2>
              <p>
                Use checksum-valid addresses for the watched transfer and a nonzero
                sender. RoundWatch selects Circle USDC. Set <code>atomicAmount</code>
                {" "}to a positive integer string in millionths of one USDC. The
                example watches for one atomic unit, or 0.000001 USDC.
              </p>
              <CodeBlock>{requestBody}</CodeBlock>
              <p className="quickstart-note">
                Generate a fresh <code>idempotencyKey</code> of 8–128 characters
                for each new watch under the service payer. Keep the exact body for
                recovery. Use the actual transfer note or omit <code>invoiceNote</code>.
                The two placeholder literals are rejected on paid creation.
                The service payer signs the fee to <code>payTo</code>.
                The <code>expectedSender</code> and <code>expectedReceiver</code>
                {" "}describe the separate transfer to be watched.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">02</span>
            <div>
              <h2>Discover the offer for free</h2>
              <p>
                Send an unsigned <code>POST</code> to receive <code>402 Payment Required</code>
                {" "}with the <code>PAYMENT-REQUIRED</code> header and Bazaar input
                metadata. Discovery skips semantic body validation and paid
                readiness checks. Admission and capacity are checked on the
                signed request.
              </p>
              <CodeBlock>{unpaidRequest}</CodeBlock>
              <p className="quickstart-note">
                Decode <code>PAYMENT-REQUIRED</code> and compare the offer with
                the approved MainNet terms below.
              </p>
              <CodeBlock>{expectedServiceContract}</CodeBlock>
              <p className="quickstart-note">
                Before signing, validate your watch body against the API schema,
                check that <code>GET /ready</code> returns <code>200</code> for
                MainNet, and confirm the resource URL, x402 version, scheme,
                network, asset, amount, and service receiver.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">03</span>
            <div>
              <h2>Sign locally and submit</h2>
              <p>
                Sign the service payment locally and keep wallet credentials in
                your client. The reference client uses the official SDK 2.29.0.
                Send the validated watch body with <code>PAYMENT-SIGNATURE</code>.
                RoundWatch checks readiness and validates the body before the
                facilitator verifies the payment. It rechecks readiness and
                durably prepares the watch before settlement.
              </p>
              <div className="quickstart-links">
                <a href={`${REPOSITORY}/blob/main/apps/client/mainnet-e2e.ts`}>
                  View guarded MainNet client <Icon name="arrow" />
                </a>
                <a href={`${API_BASE}/llms.txt`}>
                  Read payment & recovery guidance <Icon name="arrow" />
                </a>
              </div>
              <p className="quickstart-warning mono">
                A successful production purchase spends real MainNet USDC.
                For TestNet integration, run RoundWatch locally with
                ROUNDWATCH_NETWORK=testnet or use your own TestNet deployment.
              </p>
              <p className="quickstart-note">
                The November 2026 release completed a paid TestNet watch and a
                matched transfer. Its MainNet checks covered health, readiness,
                and unsigned discovery. The paid MainNet proof linked here
                predates this release.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">04</span>
            <div>
              <h2>Save the watch ID and leave</h2>
              <p>
                After settlement, RoundWatch confirms the exact service-payment
                transaction and uses its confirmed round as the activation baseline
                and initial scan cursor. A successful response returns a durable
                {" "}<code>watchId</code>. Save it before your process exits.
              </p>
              <CodeBlock>{`{
  "watchId": "YOUR_WATCH_ID",
  "message": "The watch is returned only if x402 settlement and durable activation succeed"
}`}</CodeBlock>
              <p className="quickstart-note">
                If the purchase response is lost or settlement is uncertain, recover
                the original purchase without paying again. Send the exact original
                watch body and <code>servicePayer</code> to the free
                {" "}<code>POST /v1/watch/recover</code> endpoint. It can return
                <code> watch.id</code> after settlement and activation are confirmed.
              </p>
            </div>
          </article>

          <article className="quickstart-step">
            <span className="quickstart-step-number mono">05</span>
            <div>
              <h2>Read the result later</h2>
              <p>
                Read the public status endpoint for free. A match includes the exact
                Algorand transaction ID and confirmed round. The transfer must confirm
                after the service-payment round and have a block timestamp before
                {" "}<code>expiresAt</code>. Expiry requires complete indexed coverage
                through a fixed closing checkpoint. If the budget of 500 work units
                runs out first, the result is <code>indeterminate</code>.
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
              <dd>0.10 USDC</dd>
            </div>
            <div>
              <dt>Eligibility deadline</dt>
              <dd>
                30 minutes from durable watch preparation. Settlement time consumes
                part of the window.
              </dd>
            </div>
            <div>
              <dt>Work budget</dt>
              <dd>500 durable work units per watch</dd>
            </div>
            <div>
              <dt>Open capacity</dt>
              <dd>50 globally and 5 per verified service payer</dd>
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
              <small>Local development and reference tooling</small>
            </a>
            <a href={`${REPOSITORY}/blob/main/docs/ARCHITECTURE.md`}>
              <span>Architecture</span>
              <small>Normal, recovery, and matching paths</small>
            </a>
            <a href={`${REPOSITORY}/blob/main/docs/SECURITY.md`}>
              <span>Security</span>
              <small>Signer boundary and operational assumptions</small>
            </a>
            <a href={MAINNET_PROOF}>
              <span>Historical MainNet proof</span>
              <small>Earlier paid settlement and matched transfer</small>
            </a>
            <a href={`${API_BASE}/openapi.json`}>
              <span>OpenAPI</span>
              <small>Machine-readable create and status schemas</small>
            </a>
            <a href={`${API_BASE}/llms.txt`}>
              <span>Agent contract</span>
              <small>Live machine-readable integration guidance</small>
            </a>
          </div>
        </section>

        <section className="quickstart-final">
          <div>
            <p className="eyebrow">Ready to inspect the product?</p>
            <h2>See a watch from purchase to match.</h2>
          </div>
          <div className="button-row">
            <a className="button button-primary" href="/#video-demo">
              <span>Watch the legacy demo</span>
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
