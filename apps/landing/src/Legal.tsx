const legalIdentity = {
  name: "Vladyslav Volkov",
  street: "Feldgarten 10",
  city: "44388 Dortmund",
  country: "Deutschland",
  email: "contact@roundwatch.observer",
};

type LegalKind = "impressum" | "privacy";

function LegalBrand() {
  return (
    <a className="legal-brand" href="/" aria-label="RoundWatch home">
      <svg viewBox="0 0 40 40" aria-hidden="true">
        <circle
          cx="20"
          cy="20"
          r="13"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeDasharray="69 13"
          transform="rotate(-30 20 20)"
        />
        <circle cx="31.3" cy="13.5" r="3.4" fill="#f5f3ee" />
      </svg>
      <span>RoundWatch</span>
    </a>
  );
}

function IdentityBlock() {
  return (
    <address>
      {legalIdentity.name}
      <br />
      {legalIdentity.street}
      <br />
      {legalIdentity.city}
      <br />
      {legalIdentity.country}
    </address>
  );
}

export function LegalFooterBar() {
  return (
    <div className="legal-footer-bar">
      <div className="container legal-footer-inner mono">
        <span>Legal</span>
        <nav aria-label="Legal navigation">
          <a href="/impressum">Impressum</a>
          <a href="/privacy">Datenschutz</a>
        </nav>
      </div>
    </div>
  );
}

export function LegalPage({ kind }: { kind: LegalKind }) {
  const privacy = kind === "privacy";

  return (
    <div className="legal-site">
      <header className="legal-header container">
        <LegalBrand />
        <a className="legal-back mono" href="/">
          Back to RoundWatch <span aria-hidden="true">↗</span>
        </a>
      </header>

      <main className="legal-main container">
        <p className="eyebrow">Legal / RoundWatch</p>
        <h1>{privacy ? "Privacy Policy" : "Imprint"}</h1>
        <p className="legal-kicker">
          {privacy ? "Datenschutzerklärung" : "Impressum gemäß § 5 DDG"}
        </p>

        {privacy ? <PrivacyContent /> : <ImprintContent />}
      </main>

      <footer className="legal-page-footer container mono">
        <span>© 2026 RoundWatch</span>
        <nav aria-label="Legal page navigation">
          <a href="/impressum">Impressum</a>
          <a href="/privacy">Datenschutz</a>
          <a href="/">Home</a>
        </nav>
      </footer>
    </div>
  );
}

function ImprintContent() {
  return (
    <div className="legal-copy">
      <section>
        <h2>Angaben gemäß § 5 DDG</h2>
        <IdentityBlock />
      </section>

      <section>
        <h2>Kontakt</h2>
        <p>
          E-Mail: <a href={`mailto:${legalIdentity.email}`}>{legalIdentity.email}</a>
        </p>
      </section>
    </div>
  );
}

function PrivacyContent() {
  return (
    <div className="legal-copy">
      <p className="legal-updated mono">Stand / 15. September 2026</p>

      <section>
        <h2>1. Verantwortlicher</h2>
        <IdentityBlock />
        <p>
          E-Mail: <a href={`mailto:${legalIdentity.email}`}>{legalIdentity.email}</a>
        </p>
      </section>

      <section>
        <h2>2. Hosting und Serverdaten</h2>
        <p>
          Diese Website wird über Netlify bereitgestellt. Beim Aufruf der Website
          können technisch erforderliche Verbindungs- und Gerätedaten verarbeitet
          werden, insbesondere IP-Adresse, Browser- und Geräteinformationen,
          aufgerufene URL, Referrer sowie Datum und Uhrzeit des Zugriffs. Die
          Verarbeitung dient der sicheren, stabilen und effizienten Bereitstellung
          der Website.
        </p>
        <p>
          Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO. Unser berechtigtes
          Interesse liegt in der sicheren und zuverlässigen Bereitstellung des
          Online-Angebots. Hosting-Anbieter ist Netlify, Inc., USA. Dabei kann eine
          Verarbeitung in den USA stattfinden. Netlify gibt an, für entsprechende
          Datenübermittlungen unter anderem das EU-U.S. Data Privacy Framework und
          Standardvertragsklauseln zu verwenden.
        </p>
      </section>

      <section>
        <h2>3. Kontakt per E-Mail</h2>
        <p>
          Wenn Sie uns per E-Mail kontaktieren, verarbeiten wir die von Ihnen
          übermittelten Daten, insbesondere E-Mail-Adresse, Inhalt der Nachricht
          und technische Metadaten, soweit dies zur Bearbeitung Ihrer Anfrage
          erforderlich ist.
        </p>
        <p>
          Die Kontaktadresse wird über Cloudflare Email Routing weitergeleitet und
          in einem Gmail-Postfach empfangen. Dabei können Cloudflare, Inc. und
          Google LLC als technische Dienstleister in die Verarbeitung eingebunden
          sein. Soweit eine Kommunikation der Vertragsanbahnung dient, erfolgt die
          Verarbeitung auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO; im Übrigen auf
          Grundlage von Art. 6 Abs. 1 lit. f DSGVO zur Bearbeitung von Anfragen.
        </p>
      </section>

      <section>
        <h2>4. Cookies, Tracking und externe Inhalte</h2>
        <p>
          RoundWatch setzt derzeit keine nicht notwendigen Cookies ein und verwendet
          keine Webanalyse, Werbetracker oder eingebetteten Inhalte externer
          Plattformen. Die auf der Website verwendeten Schriftarten werden lokal
          ausgeliefert. Daher wird derzeit kein Consent-Banner für Analyse- oder
          Marketingtechnologien eingesetzt.
        </p>
      </section>

      <section>
        <h2>5. Speicherdauer</h2>
        <p>
          Personenbezogene Daten werden nur so lange verarbeitet, wie dies für den
          jeweiligen Zweck erforderlich ist oder gesetzliche Aufbewahrungspflichten
          bestehen. Auf technische Server- und Sicherheitsprotokolle des
          Hosting-Anbieters haben wir nur im Rahmen der dort bereitgestellten
          Funktionen Einfluss.
        </p>
      </section>

      <section>
        <h2>6. Ihre Rechte</h2>
        <p>
          Sie haben im Rahmen der gesetzlichen Voraussetzungen insbesondere das
          Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung,
          Datenübertragbarkeit sowie Widerspruch gegen eine auf Art. 6 Abs. 1 lit. f
          DSGVO gestützte Verarbeitung. Außerdem besteht das Recht, sich bei einer
          Datenschutzaufsichtsbehörde zu beschweren.
        </p>
      </section>

      <section>
        <h2>7. Änderungen dieser Datenschutzerklärung</h2>
        <p>
          Diese Datenschutzerklärung wird angepasst, wenn sich die Website,
          eingesetzte Dienste oder rechtliche Anforderungen wesentlich ändern.
        </p>
      </section>
    </div>
  );
}
