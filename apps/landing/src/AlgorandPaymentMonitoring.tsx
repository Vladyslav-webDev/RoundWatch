import { BrandMark, Icon } from "./graphics";

const INDEXER_DOCS =
  "https://dev.algorand.co/reference/rest-api/indexer/operations/searchfortransactions/";
const PENDING_DOCS =
  "https://dev.algorand.co/docs/algokit-utils/typescript/latest/api/subpaths/algod-client/classes/algodclient/";

const indexerQuery = [
  "GET https://YOUR_INDEXER/v2/transactions",
  "  ?address=EXPECTED_RECEIVER",
  "  &address-role=receiver",
  "  &asset-id=31566704",
  "  &tx-type=axfer",
  "  &min-round=START_ROUND",
].join("\n");

const exactMatchPseudo = [
  "// Pseudocode: the Indexer narrows the search; your app still owns exact matching.",
  "for (const tx of response.transactions) {",
  "  if (",
  "    senderMatches(tx, expectedSender) &&",
  "    receiverMatches(tx, expectedReceiver) &&",
  "    assetMatches(tx, 31566704) &&",
  "    amountMatches(tx, atomicAmount) &&",
  "    noteMatches(tx, invoiceNote)",
  "  ) {",
  "    persistEvidence(tx);",
  "  }",
  "}",
].join("\n");

const roundWatchRequest = [
  "POST /v1/watch",
  "content-type: application/json",
  "",
  "{",
  '  "idempotencyKey": "invoice-2026-09-22-001",',
  '  "expectedSender": "EXPECTED_SENDER",',
  '  "expectedReceiver": "EXPECTED_RECEIVER",',
  '  "atomicAmount": "1000000",',
  '  "invoiceNote": "roundwatch:invoice-2026-09-22-001"',
  "}",
].join("\n");

const statusRequest = [
  "GET /v1/watch/YOUR_WATCH_ID",
  "",
  "// Return later. The caller does not need to keep its own chain-watching",
  "// process alive between watch creation and status retrieval.",
].join("\n");

function GuideBrand() {
  return (
    <a className="guide-brand" href="/" aria-label="RoundWatch home">
      <BrandMark orbital />
      <span>RoundWatch</span>
    </a>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="guide-code">
      <code>{children}</code>
    </pre>
  );
}

function GuideHeader() {
  return (
    <header className="guide-header container">
      <GuideBrand />
      <nav aria-label="Guide navigation">
        <a href="/">Product</a>
        <a href="/start">Quickstart</a>
        <a href="#build-or-delegate">Build vs delegate</a>
      </nav>
    </header>
  );
}

export default function AlgorandPaymentMonitoringPage() {
  return (
    <div className="guide-site">
      <a className="skip-link" href="#guide-main">
        Skip to content
      </a>
      <GuideHeader />

      <main id="guide-main" className="guide-main container">
        <section className="guide-hero" aria-labelledby="guide-title">
          <p className="eyebrow">Technical guide / Algorand payments</p>
          <h1 id="guide-title">
            Monitor a Future Algorand USDC Payment Without Running a Worker
          </h1>
          <p className="guide-lede">
            The hard case is not confirming a transaction you already submitted.
            It is waiting for a payment that does not exist yet, when there is no
            transaction ID to query. This guide shows what an application must own
            to monitor that future payment reliably, and where RoundWatch can take
            over the durable waiting obligation.
          </p>
          <div className="guide-thesis mono" aria-label="Core distinction">
            <span>Known txId → confirm an existing transaction</span>
            <span>Future payment → discover, match, persist, recover</span>
          </div>
        </section>

        <div className="guide-layout">
          <aside className="guide-toc" aria-label="On this page">
            <p className="mono">On this page</p>
            <a href="#problem">01 / The problem</a>
            <a href="#txid">02 / Why txId polling is different</a>
            <a href="#indexer">03 / Build it with Indexer</a>
            <a href="#failure-modes">04 / Production failure modes</a>
            <a href="#build-or-delegate">05 / Build vs delegate</a>
            <a href="#evidence">06 / Retrieve evidence</a>
            <a href="#fit">07 / When RoundWatch fits</a>
            <a href="#faq">08 / FAQ</a>
          </aside>

          <article className="guide-article">
            <section id="problem">
              <p className="guide-section-number mono">01 / The problem</p>
              <h2>The expected payment exists before the transaction does.</h2>
              <p>
                Imagine an invoice or agent workflow that already knows the expected
                sender, receiver, USDC amount, and optionally an invoice note. The
                payer has not sent the transfer yet. There is therefore no
                <code> txId </code>
                to confirm.
              </p>
              <p>
                Your application now needs to observe future Algorand rounds, find a
                candidate asset-transfer transaction, apply the exact business
                predicate, and remember enough progress to continue after a restart.
                That is a different problem from checking the status of a transaction
                you already know.
              </p>
              <div className="guide-callout">
                <span className="mono">The useful boundary</span>
                <strong>Future payment with no txId yet.</strong>
                <p>
                  RoundWatch models that expectation as a durable watch instead of
                  tying it to one caller process.
                </p>
              </div>
            </section>

            <section id="txid">
              <p className="guide-section-number mono">
                02 / Why txId polling is different
              </p>
              <h2>Algod confirmation starts after you already know the transaction.</h2>
              <p>
                Algorand&apos;s algod client exposes
                <code> pendingTransactionInformation(txId)</code> for a recently
                submitted transaction. That is the right primitive when the
                transaction ID is already known. It cannot discover a future transfer
                whose ID does not exist yet.
              </p>
              <a
                className="guide-source"
                href={PENDING_DOCS}
                target="_blank"
                rel="noreferrer"
              >
                Algorand docs: pendingTransactionInformation(txId)
                <Icon name="arrow" />
              </a>
            </section>

            <section id="indexer">
              <p className="guide-section-number mono">03 / Build it with Indexer</p>
              <h2>The Indexer gives you search primitives, not your payment lifecycle.</h2>
              <p>
                Algorand Indexer can search transactions by address and role, asset
                ID, round range, note prefix, transaction type, and amount bounds.
                That makes it a strong foundation for discovering candidates.
              </p>
              <CodeBlock>{indexerQuery}</CodeBlock>
              <p>
                A practical implementation can query by receiver, MainNet USDC asset,
                transaction type, and the last safely processed round. It then
                post-filters candidates against the full payment contract.
              </p>
              <CodeBlock>{exactMatchPseudo}</CodeBlock>
              <a
                className="guide-source"
                href={INDEXER_DOCS}
                target="_blank"
                rel="noreferrer"
              >
                Algorand Indexer docs: searchForTransactions
                <Icon name="arrow" />
              </a>

              <div className="guide-checklist">
                <h3>What your application still has to own</h3>
                <ul>
                  <li>the expected sender and receiver</li>
                  <li>the fixed asset identity</li>
                  <li>the exact atomic amount</li>
                  <li>the optional invoice-note predicate</li>
                  <li>a safe starting round and scan cursor</li>
                  <li>pagination and retry behavior</li>
                  <li>restart recovery</li>
                  <li>idempotency for repeated watch creation</li>
                  <li>terminal result persistence</li>
                </ul>
              </div>
            </section>

            <section id="failure-modes">
              <p className="guide-section-number mono">
                04 / Production failure modes
              </p>
              <h2>The loop is easy. The durable state machine is the real work.</h2>
              <div className="guide-failure-grid">
                <article>
                  <span className="mono">Restart</span>
                  <h3>The process dies between rounds.</h3>
                  <p>
                    Without a persisted cursor, the next process must guess where to
                    resume and can either rescan excessively or leave a gap.
                  </p>
                </article>
                <article>
                  <span className="mono">Pagination</span>
                  <h3>The candidate set spans multiple pages.</h3>
                  <p>
                    A durable scanner has to advance only after it knows the relevant
                    result window was processed safely.
                  </p>
                </article>
                <article>
                  <span className="mono">False positive</span>
                  <h3>The receiver got a different USDC transfer.</h3>
                  <p>
                    Receiver-only matching is insufficient. Sender, asset, amount,
                    and the optional note all belong to the payment predicate.
                  </p>
                </article>
                <article>
                  <span className="mono">Duplicate request</span>
                  <h3>The caller retries watch creation.</h3>
                  <p>
                    Idempotency matters because a network retry should not create two
                    independent obligations for the same invoice.
                  </p>
                </article>
                <article>
                  <span className="mono">Late payment</span>
                  <h3>The payment appears near or after a deadline.</h3>
                  <p>
                    Expiry should be based on complete indexed coverage of the closing
                    range, not merely on wall-clock time passing.
                  </p>
                </article>
                <article>
                  <span className="mono">Evidence</span>
                  <h3>The match must survive after detection.</h3>
                  <p>
                    Store the matching transaction evidence so a later workflow can
                    retrieve the same result instead of rediscovering it.
                  </p>
                </article>
              </div>
            </section>

            <section id="build-or-delegate">
              <p className="guide-section-number mono">05 / Build vs delegate</p>
              <h2>You can own the worker, or you can own only the payment intent.</h2>

              <div className="guide-compare">
                <div>
                  <p className="mono">Build it yourself</p>
                  <ol>
                    <li>Create a persistent job.</li>
                    <li>Capture the starting round.</li>
                    <li>Poll and paginate Indexer results.</li>
                    <li>Persist cursor progress.</li>
                    <li>Recover safely after restarts.</li>
                    <li>Apply the exact payment predicate.</li>
                    <li>Persist the terminal evidence.</li>
                  </ol>
                </div>
                <div className="guide-compare-accent">
                  <p className="mono">Delegate to RoundWatch</p>
                  <ol>
                    <li>Define the exact expected payment.</li>
                    <li>Create one durable watch.</li>
                    <li>Save the returned watch ID.</li>
                    <li>Let the caller exit.</li>
                    <li>Read the durable result later.</li>
                  </ol>
                </div>
              </div>

              <p>
                RoundWatch does not replace Algorand Indexer. It packages the
                long-lived observation, cursor persistence, restart recovery,
                exact-match predicate, and stored result into a bounded API
                obligation.
              </p>

              <CodeBlock>{roundWatchRequest}</CodeBlock>

              <div className="guide-actions">
                <a className="button button-primary" href="/start">
                  <span>Open the 60-second quickstart</span>
                  <Icon name="arrow" />
                </a>
                <a
                  className="button button-secondary"
                  href="https://github.com/Vladyslav-webDev/x402-challenge"
                >
                  <span>Inspect the implementation</span>
                  <Icon name="arrow" />
                </a>
              </div>
            </section>

            <section id="evidence">
              <p className="guide-section-number mono">06 / Retrieve evidence</p>
              <h2>Your workflow can return after the waiting period.</h2>
              <p>
                After durable watch creation succeeds, keep the
                <code> watchId</code>. The caller can terminate and later query the
                public watch status endpoint. A matched watch preserves the exact
                Algorand transaction ID and confirmed round that satisfied the watch.
              </p>
              <CodeBlock>{statusRequest}</CodeBlock>
              <p className="guide-note">
                The current operating contract, states, capacity limits, and MainNet
                integration steps are documented on the quickstart page rather than
                duplicated here.
              </p>
            </section>

            <section id="fit">
              <p className="guide-section-number mono">07 / When RoundWatch fits</p>
              <h2>Use the abstraction only when it removes work you actually have.</h2>
              <div className="guide-fit-grid">
                <div>
                  <h3>RoundWatch is useful when…</h3>
                  <ul>
                    <li>the transaction does not exist yet</li>
                    <li>you know the expected payment fields in advance</li>
                    <li>your caller should be free to exit</li>
                    <li>restart-safe observation would otherwise be your job</li>
                    <li>you need durable evidence after the match</li>
                  </ul>
                </div>
                <div>
                  <h3>You probably do not need it when…</h3>
                  <ul>
                    <li>you already know the txId and only need confirmation</li>
                    <li>you already run a durable Indexer ingestion pipeline</li>
                    <li>your backend already owns persistent queues and recovery</li>
                    <li>you require push webhook delivery rather than later retrieval</li>
                  </ul>
                </div>
              </div>
            </section>

            <section id="faq">
              <p className="guide-section-number mono">08 / FAQ</p>
              <h2>Common implementation questions.</h2>
              <div className="guide-faq">
                <details>
                  <summary>
                    Why not just call pendingTransactionInformation()?
                  </summary>
                  <p>
                    That API takes a transaction ID. A future invoice payment has no
                    transaction ID until the payer creates and submits the transfer.
                  </p>
                </details>
                <details>
                  <summary>Does RoundWatch replace Algorand Indexer?</summary>
                  <p>
                    No. Indexer is the chain-data search layer. RoundWatch is the
                    durable payment-observation lifecycle built on top of chain data.
                  </p>
                </details>
                <details>
                  <summary>Is RoundWatch a webhook service?</summary>
                  <p>
                    No. The current product persists the watch and its result; the
                    client retrieves status later. It solves the durable observation
                    problem that often sits underneath a webhook integration.
                  </p>
                </details>
                <details>
                  <summary>Why match more than receiver and amount?</summary>
                  <p>
                    Because an unrelated transfer can share a receiver or amount.
                    Exact payment intent is stronger when sender, receiver, fixed
                    asset, amount, and an optional invoice note all agree.
                  </p>
                </details>
              </div>
            </section>

            <section className="guide-final">
              <p className="eyebrow">From explanation to integration</p>
              <h2>Create the watch. Let RoundWatch own the wait.</h2>
              <p>
                The quickstart contains the current MainNet request flow, operating
                limits, states, and reference implementation.
              </p>
              <a className="button button-primary" href="/start">
                <span>Start in 60 seconds</span>
                <Icon name="arrow" />
              </a>
            </section>
          </article>
        </div>
      </main>

      <footer className="guide-footer container mono">
        <span>© 2026 RoundWatch</span>
        <nav aria-label="Guide footer navigation">
          <a href="/">Product</a>
          <a href="/start">Quickstart</a>
          <a href="/impressum">Impressum</a>
          <a href="/privacy">Datenschutz</a>
        </nav>
      </footer>
    </div>
  );
}
