import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BrandMark, Icon, StateStack } from "./graphics";
import type { IconName } from "./graphics";
import WorkflowReplay from "./WorkflowReplay";

const navigation = [
  { label: "Product", id: "product" },
  { label: "How it works", id: "how-it-works" },
  { label: "Technology", id: "technology" },
  { label: "Demo", id: "demo" },
];
const flow = [
  {
    title: "Agent performs work",
    text: "An autonomous agent completes the requested task.",
    icon: "work",
    detail:
      "Useful work is complete. Payment settlement is still a separate event.",
  },
  {
    title: "x402 payment initiated",
    text: "Payment enters the settlement workflow.",
    icon: "code",
    detail:
      "Initiating a payment is not proof of settlement. The workflow waits for evidence.",
  },
  {
    title: "RoundWatch observes",
    text: "RoundWatch waits for successful settlement evidence and persists the resulting state.",
    icon: "database",
    detail:
      "Successful settlement evidence is the condition for advancing durable state.",
  },
  {
    title: "Verified & continue",
    text: "The workflow now has durable evidence from which the next action can safely proceed.",
    icon: "check",
    detail:
      "Verified, persisted evidence gives the next action a trustworthy starting point.",
  },
] satisfies { title: string; text: string; icon: IconName; detail: string }[];

function ButtonLink({
  href,
  children,
  secondary = false,
}: {
  href: string;
  children: ReactNode;
  secondary?: boolean;
}) {
  return (
    <a
      className={`button ${secondary ? "button-secondary" : "button-primary"}`}
      href={href}
    >
      <span>{children}</span>
      <Icon name="arrow" />
    </a>
  );
}

function Brand() {
  return (
    <a className="brand" href="#top" aria-label="RoundWatch home">
      <BrandMark />
      <span>RoundWatch</span>
    </a>
  );
}

function Eyebrow({
  number,
  children,
}: {
  number: string;
  children: ReactNode;
}) {
  return (
    <p className="eyebrow">
      <span>{number}</span>
      <span className="eyebrow-slash">/</span>
      {children}
    </p>
  );
}

function Header() {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    function outside(event: PointerEvent) {
      if (
        event.target instanceof Node &&
        !header.current?.contains(event.target)
      )
        setOpen(false);
    }
    const wide = window.matchMedia("(min-width: 761px)");
    const close = () => setOpen(false);
    document.addEventListener("keydown", escape);
    document.addEventListener("pointerdown", outside);
    wide.addEventListener("change", close);
    return () => {
      document.removeEventListener("keydown", escape);
      document.removeEventListener("pointerdown", outside);
      wide.removeEventListener("change", close);
    };
  }, [open]);
  return (
    <header
      className="site-header"
      ref={header}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      <div className="header-inner">
        <Brand />
        <button
          ref={trigger}
          className="menu-toggle"
          aria-expanded={open}
          aria-controls="primary-navigation"
          onClick={() => setOpen((value) => !value)}
        >
          <span>{open ? "Close" : "Menu"}</span>
          <span
            className={`menu-lines ${open ? "menu-lines-open" : ""}`}
            aria-hidden="true"
          >
            <i />
            <i />
          </span>
        </button>
        <nav
          id="primary-navigation"
          className={`primary-nav ${open ? "nav-open" : ""}`}
          aria-label="Main navigation"
        >
          {navigation.map((item) => (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a className="header-cta button button-secondary" href="#demo">
          <span>View demo</span>
          <Icon name="arrow" />
        </a>
      </div>
    </header>
  );
}

function Product() {
  return (
    <section
      id="product"
      className="section product"
      data-reveal
      aria-labelledby="product-title"
    >
      <div className="section-heading">
        <div>
          <Eyebrow number="01">Product</Eyebrow>
          <h2 id="product-title">
            Reliable continuity
            <br />
            for autonomous work.
          </h2>
        </div>
        <p>
          Work can be autonomous.
          <br />
          Trust needs a foundation.
        </p>
      </div>
      <div className="product-layout">
        <div className="observation-visual" aria-hidden="true">
          <div className="observer-orbit orbit-outer" />
          <div className="observer-orbit orbit-middle" />
          <div className="observer-orbit orbit-inner" />
          <div className="orbit-rotator ambient">
            <i />
          </div>
          <div className="orbit-center">
            <BrandMark />
          </div>
          <span className="orbit-label label-top mono">Expected payment</span>
          <span className="orbit-label label-bottom mono">
            A signal you can trust
          </span>
          <div className="orbit-crosshair" />
        </div>
        <div className="capability-list">
          {[
            [
              "Observe",
              "Watches for the payment event the workflow is expecting.",
              "01",
              "eye",
            ],
            [
              "Verify",
              "State advances only from successful settlement evidence.",
              "02",
              "shield",
            ],
            [
              "Persist",
              "Settlement state and observation progress survive process restarts.",
              "03",
              "database",
            ],
          ].map(([title, text, number, icon]) => (
            <div className="capability" key={title}>
              <span className="mono capability-index">{number}</span>
              <div>
                <h3>{title}</h3>
                <p>{text}</p>
              </div>
              <Icon name={icon as IconName} />
            </div>
          ))}
        </div>
      </div>
      <div className="product-boundary mono">
        <span>Expected payment</span>
        <span aria-hidden="true">→</span>
        <span>Verified evidence</span>
        <span aria-hidden="true">→</span>
        <span>Next action</span>
      </div>
    </section>
  );
}

function Flow() {
  const [selected, setSelected] = useState(2);
  return (
    <section
      id="how-it-works"
      className="section flow-section"
      data-reveal
      aria-labelledby="flow-title"
    >
      <div className="section-heading">
        <div>
          <Eyebrow number="02">The flow</Eyebrow>
          <h2 id="flow-title">
            From completed work
            <br />
            to what’s next.
          </h2>
        </div>
        <p>
          A payment is a moment.
          <br />
          Verified state is a starting point.
        </p>
      </div>
      <ol className="flow-rail">
        {flow.map((item, index) => (
          <li
            className={`flow-step ${selected === index ? "step-selected" : ""}`}
            key={item.title}
          >
            <span className="step-number mono">0{index + 1}</span>
            <div className="node-row">
              <button
                className="flow-node"
                onClick={() => setSelected(index)}
                aria-label={`Explore stage ${index + 1}: ${item.title}`}
                aria-pressed={selected === index}
                aria-controls="flow-explanation"
              >
                <Icon name={item.icon} />
              </button>
              <span className="rail-segment" aria-hidden="true">
                <i
                  className="rail-pulse ambient"
                  style={{ animationDelay: `${index * -1.7}s` }}
                />
              </span>
            </div>
            <div className="step-copy">
              <h3>{item.title}</h3>
              <p>{item.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="flow-explanation" id="flow-explanation">
        <span className="mono">
          The boundary <span>0{selected + 1}</span>
        </span>
        <p aria-live="polite">{flow[selected].detail}</p>
      </div>
    </section>
  );
}

function Technology() {
  return (
    <section
      id="technology"
      className="section technology"
      data-reveal
      aria-labelledby="technology-title"
    >
      <Eyebrow number="03">Technology</Eyebrow>
      <h2 id="technology-title">
        Deterministic where it matters.
        <br />
        <span className="muted-heading">Intelligent where it helps.</span>
      </h2>
      <div className="technology-layout">
        <div className="architecture-core">
          <p className="mono diagram-label">The deterministic core</p>
          <ol className="architecture-path">
            <li>
              <Icon name="work" />
              <span>Agent</span>
              <small>Completes the task</small>
            </li>
            <li>
              <Icon name="code" />
              <span>x402 payment</span>
              <small>Initiates the payment</small>
            </li>
            <li>
              <Icon name="link" />
              <span>Algorand settlement</span>
              <small>Establishes the on-chain result</small>
            </li>
            <li className="architecture-watch">
              <BrandMark />
              <span>RoundWatch</span>
              <small>Observes, verifies, persists</small>
            </li>
            <li className="architecture-evidence">
              <Icon name="shield" />
              <span>Verified durable evidence</span>
              <small>The basis for workflow continuation</small>
            </li>
          </ol>
          <p className="architecture-next mono">
            <Icon name="arrow" />
            Workflow continuation
          </p>
        </div>
        <div className="technology-copy">
          <h3>
            Evidence first.
            <br />
            Every next step, grounded.
          </h3>
          <p>
            Settlement is established by deterministic infrastructure. A
            language model does not decide whether a payment settled.
          </p>
          <ul className="capability-checks">
            {[
              "Settlement observation",
              "Successful-settlement evidence",
              "Durable state",
              "Persistent scan cursor",
              "Restart recovery",
              "Future-payment detection",
            ].map((item) => (
              <li key={item}>
                <Icon name="check" />
                {item}
              </li>
            ))}
          </ul>
          <p className="prototype-note">
            <span className="signal-dot" />
            Verified in the Algorand TestNet prototype.
          </p>
          <aside className="reasoning-note">
            <span className="mono">An open path for reasoning</span>
            <div className="reasoning-path">
              <span>Verified evidence</span>
              <Icon name="arrow" />
              <span>Intelligent reasoning</span>
              <Icon name="arrow" />
              <span>Next action</span>
            </div>
            <p>Reason over verified evidence — never replace it.</p>
            <small>
              A future extension. GPT-6 Astra is used to build RoundWatch; it is
              not a step in the current runtime.
            </small>
          </aside>
        </div>
      </div>
    </section>
  );
}

function Resilience() {
  return (
    <section
      className="section resilience"
      data-reveal
      aria-labelledby="resilience-title"
    >
      <div className="resilience-copy">
        <Eyebrow number="05">Resilience</Eyebrow>
        <h2 id="resilience-title">
          Restart the server.
          <br />
          <span className="orange-text">Keep the truth.</span>
        </h2>
        <p>A process can stop. Its evidence shouldn’t disappear with it.</p>
        <p>
          RoundWatch restores durable state and resumes from saved observation
          progress. A future payment can still be detected after restart.
        </p>
        <span className="proof-note mono">
          <Icon name="check" />
          Verified with a real process restart
          <br />
          on Algorand TestNet
        </span>
      </div>
      <div className="restart-diagram">
        <p className="mono diagram-label">Process changes. Evidence remains.</p>
        <ol className="restart-timeline">
          {[
            "Payment expected",
            "Scan progress saved",
            "Server stops",
            "Server starts",
            "State restored",
            "Observation resumes",
            "Future payment detected",
          ].map((item, i) => (
            <li
              key={item}
              className={
                i === 2
                  ? "restart-stop"
                  : i === 3
                    ? "restart-start"
                    : i === 6
                      ? "restart-detected"
                      : ""
              }
            >
              <span className="restart-node" aria-hidden="true">
                {i === 2 ? "×" : i === 6 ? <Icon name="check" /> : ""}
              </span>
              <span>{item}</span>
              <small className="mono">
                {i === 1
                  ? "Saved"
                  : i === 2
                    ? "Process offline"
                    : i === 4
                      ? "Recovered"
                      : i === 6
                        ? "Matched"
                        : ""}
              </small>
            </li>
          ))}
        </ol>
        <span className="persistent-bridge mono">Durable state</span>
      </div>
    </section>
  );
}

function Ecosystem() {
  const words = ["PRODUCT HUNT", "OPENAI", "GPT-6 ASTRA", "ALGORAND", "x402"];
  return (
    <section className="ecosystem" aria-label="Technology and launch context">
      <div className="container ecosystem-caption">
        <span className="mono">
          Built with open standards. Made for what’s next.
        </span>
        <span>Product Hunt is our launch platform.</span>
      </div>
      <div className="ribbon">
        <div className="ribbon-track ambient">
          {[0, 1].map((copy) => (
            <div
              className="ribbon-group"
              key={copy}
              aria-hidden={copy === 1 ? true : undefined}
            >
              {words.map((word) => (
                <span
                  className={`ribbon-word ${word === "x402" ? "word-x402" : ""}`}
                  key={word}
                >
                  {word}
                  <i aria-hidden="true">✳</i>
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

export default function App() {
  // Match the build-time HTML on the first render; CSS applies the user's
  // motion preference immediately, before React hydrates the controls.
  const [reducedMotion, setReducedMotion] = useState(false);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (reducedMotion || !("IntersectionObserver" in window)) return;
    const sections = [
      ...document.querySelectorAll<HTMLElement>("[data-reveal]"),
    ];
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.remove("reveal-pending");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.08 },
    );
    for (const section of sections) {
      if (section.getBoundingClientRect().top > window.innerHeight)
        section.classList.add("reveal-pending");
      observer.observe(section);
    }
    return () => {
      observer.disconnect();
      sections.forEach((section) => section.classList.remove("reveal-pending"));
    };
  }, [reducedMotion]);

  return (
    <div id="top" className="site" data-paused={paused || reducedMotion}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <Header />
      <main id="main">
        <div className="container">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <p className="eyebrow hero-eyebrow">
                AI agents <span>×</span> Payments <span>×</span> Verified
                continuity
              </p>
              <h1 id="hero-title">
                Agents do the work.
                <br />
                <span>
                  We prove they
                  <br className="hero-break" /> got paid.
                </span>
              </h1>
              <p className="hero-description">
                RoundWatch observes agent payments, verifies settlement, and
                preserves durable evidence so autonomous workflows can safely
                keep moving.
              </p>
              <div className="button-row">
                <ButtonLink href="#demo">See the demo</ButtonLink>
                <ButtonLink href="#how-it-works" secondary>
                  How it works
                </ButtonLink>
              </div>
              <p className="hero-proof mono">
                <i className="signal-dot" />
                Built on x402. Proven on Algorand TestNet.
              </p>
            </div>
            <div className="hero-art">
              <StateStack />
            </div>
            <div className="hero-bottom mono">
              <span>Infrastructure for the next action</span>
              <button
                className="motion-toggle"
                aria-pressed={paused || reducedMotion}
                disabled={reducedMotion}
                onClick={() => setPaused((value) => !value)}
              >
                <Icon name={paused || reducedMotion ? "play" : "pause"} />
                {reducedMotion
                  ? "Reduced motion"
                  : paused
                    ? "Resume motion"
                    : "Pause motion"}
              </button>
            </div>
          </section>
          <ul className="proof-strip">
            {[
              ["link", "On-chain verification", "Real settlements"],
              ["database", "Persistent state", "Survives restarts"],
              ["shield", "Restart-safe", "Agents keep going"],
              ["bolt", "Built for agentic workflows", "Open standards"],
            ].map(([icon, title, label]) => (
              <li key={title}>
                <Icon name={icon as IconName} />
                <div>
                  <span>{title}</span>
                  <small className="mono">{label}</small>
                </div>
              </li>
            ))}
          </ul>
          <Product />
          <Flow />
          <Technology />
          <section
            id="demo"
            className="section demo"
            data-reveal
            aria-labelledby="demo-title"
          >
            <div className="section-heading">
              <div>
                <Eyebrow number="04">Demo</Eyebrow>
                <h2 id="demo-title">
                  Watch a payment
                  <br />
                  become trusted state.
                </h2>
              </div>
              <p>
                Follow the boundary from completed work to durable evidence, one
                event at a time.
              </p>
            </div>
            <WorkflowReplay reducedMotion={reducedMotion} />
          </section>
          <Resilience />
          <section
            className="section why"
            data-reveal
            aria-labelledby="why-title"
          >
            <Eyebrow number="06">Why it matters</Eyebrow>
            <h2 id="why-title">
              A more reliable
              <br />
              agent economy.
            </h2>
            <div className="audiences">
              {[
                [
                  "For agents",
                  "The confidence to continue.",
                  "Know when a paid workflow has reliable evidence to continue.",
                  "01",
                ],
                [
                  "For services",
                  "A clearer payment boundary.",
                  "Create a clearer boundary between completed work, settlement, and what happens next.",
                  "02",
                ],
                [
                  "For developers",
                  "State that outlasts a process.",
                  "Use durable settlement state instead of relying on volatile process memory.",
                  "03",
                ],
              ].map(([label, title, copy, number]) => (
                <article className="audience" key={label}>
                  <span className="mono audience-label">
                    {label}
                    <span>{number}</span>
                  </span>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                  <span className="audience-line" aria-hidden="true" />
                </article>
              ))}
            </div>
          </section>
        </div>
        <Ecosystem />
        <div className="container">
          <section
            className="challenge"
            data-reveal
            aria-labelledby="challenge-title"
          >
            <div>
              <p className="eyebrow">Built with GPT-6 Astra</p>
              <h2 id="challenge-title">
                Built on evidence.
                <br />
                Built with intelligence.
              </h2>
            </div>
            <div>
              <p className="challenge-marker mono">
                GPT-6 Astra Challenge
                <br />
                <span>Product Hunt · September 18, 2026</span>
              </p>
              <p>
                We’re building RoundWatch with GPT-6 Astra: deterministic
                settlement infrastructure, developed with intelligent tooling.
              </p>
              <p className="challenge-footnote">
                The model helps build the system. Verified settlement remains
                the foundation.
              </p>
            </div>
          </section>
          <section
            className="final-cta"
            data-reveal
            aria-labelledby="cta-title"
          >
            <p className="eyebrow">The next action starts with trust</p>
            <h2 id="cta-title">
              Watch autonomous work
              <br />
              <span>complete the loop.</span>
            </h2>
            <div className="button-row">
              <ButtonLink href="#demo">View demo</ButtonLink>
              <ButtonLink href="#how-it-works" secondary>
                How it works
              </ButtonLink>
            </div>
            <div className="cta-orbit" aria-hidden="true">
              <i />
              <i />
              <i />
            </div>
          </section>
        </div>
      </main>
      <footer className="site-footer container">
        <div className="footer-top">
          <div>
            <Brand />
            <p>
              Reliable settlement evidence
              <br />
              for autonomous work.
            </p>
          </div>
          <nav aria-label="Footer navigation">
            {navigation.map((item) => (
              <a href={`#${item.id}`} key={item.id}>
                {item.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="footer-bottom mono">
          <span>© 2026 RoundWatch</span>
          <span>roundwatch.observer</span>
          <a href="#top">
            Back to top <span aria-hidden="true">↑</span>
          </a>
        </div>
      </footer>
    </div>
  );
}
