import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { BrandMark, Icon, StateStack } from "./graphics";
import type { IconName } from "./graphics";
import WorkflowReplay from "./WorkflowReplay";
import Resilience from "./Resilience";
import VideoShowcase from "./VideoShowcase";
import { MotionProvider, useMotion } from "./motion";

const navigation = [
  { label: "Product", href: "#product" },
  { label: "Quickstart", href: "/start" },
  { label: "Technology", href: "#technology" },
  { label: "Demo", href: "#video-demo" },
];

const flow = [
  {
    title: "Define the exact payment",
    text: "The caller specifies the sender, receiver, atomic amount, and optional invoice note.",
    icon: "work",
    detail:
      "RoundWatch persists the exact watch specification before the paid retry, so the obligation has a durable identity from the start.",
    status: "Watch specified",
    boundary: "No service settlement yet",
    next: "Settle x402 fee",
  },
  {
    title: "Settle the x402 service fee",
    text: "The client signs locally and retries the same request through the x402 payment flow.",
    icon: "code",
    detail:
      "GoPlausible verifies and settles the service payment. RoundWatch never needs the caller’s mnemonic or private key.",
    status: "Settlement established",
    boundary: "Activation still requires a safe round",
    next: "Activate watch",
  },
  {
    title: "RoundWatch owns the wait",
    text: "A safe Algorand round and scan progress are persisted so the caller can exit.",
    icon: "database",
    detail:
      "The durable watch keeps polling from a saved cursor. Restart recovery preserves the waiting obligation instead of tying it to one process lifetime.",
    status: "Watch active",
    boundary: "Future payment not matched",
    next: "Observe MainNet",
  },
  {
    title: "Match & retrieve evidence",
    text: "The first exact future USDC transfer is stored with its transaction ID and confirmed round.",
    icon: "check",
    detail:
      "Sender, receiver, MainNet USDC asset, atomic amount, and optional note must all agree before the watch becomes matched.",
    status: "Durable evidence ready",
    boundary: "Exact match established",
    next: "Workflow continuation",
  },
] satisfies {
  title: string;
  text: string;
  icon: IconName;
  detail: string;
  status: string;
  boundary: string;
  next: string;
}[];

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
      <BrandMark orbital />
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
              key={item.href}
              href={item.href}
              onClick={() => setOpen(false)}
            >
              {item.label}
            </a>
          ))}
        </nav>
        <a className="header-cta button button-secondary" href="#video-demo">
          <span>View demo</span>
          <Icon name="arrow" />
        </a>
      </div>
    </header>
  );
}

function Product() {
  const [active, setActive] = useState("Observe");
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
      <div className="product-layout" data-capability={active.toLowerCase()}>
        <div className="observation-visual" aria-hidden="true">
          <div className="observer-orbit orbit-outer" />
          <div className="observer-orbit orbit-middle" />
          <div className="observer-orbit orbit-inner" />
          <div className="orbit-signal-depth">
            <div className="orbit-rotator ambient">
              <i />
            </div>
          </div>
          <div className="orbit-center">
            <BrandMark orbital charge={false} />
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
              "Watches one exact future Algorand USDC payment after the caller exits.",
              "01",
              "eye",
            ],
            [
              "Verify",
              "Matches sender, receiver, asset, atomic amount, and optional invoice note.",
              "02",
              "shield",
            ],
            [
              "Persist",
              "Watch state and scan progress survive process restarts and redeploys.",
              "03",
              "database",
            ],
          ].map(([title, text, number, icon]) => (
            <div
              className="capability"
              key={title}
              data-active={active === title}
              onPointerEnter={(event) => {
                if (event.pointerType !== "touch") setActive(title);
              }}
            >
              <span className="mono capability-index">{number}</span>
              <div>
                <h3>
                  <button
                    className="capability-control"
                    aria-pressed={active === title}
                    aria-describedby={`capability-${number}`}
                    onFocus={() => setActive(title)}
                    onClick={() => setActive(title)}
                  >
                    {title}
                  </button>
                </h3>
                <p id={`capability-${number}`}>{text}</p>
              </div>
              <Icon name={icon as IconName} />
            </div>
          ))}
        </div>
      </div>
      <div className="product-boundary mono">
        <span>Expected payment</span>
        <span aria-hidden="true">→</span>
        <span>Durable watch</span>
        <span aria-hidden="true">→</span>
        <span>Verified evidence</span>
      </div>
    </section>
  );
}

function Flow() {
  const [selected, setSelected] = useState(2);
  const [inspected, setInspected] = useState(false);
  return (
    <section
      id="how-it-works"
      className="section flow-section"
      data-reveal
      aria-labelledby="flow-title"
    >
      <div className="section-heading">
        <div>
          <Eyebrow number="03">The flow</Eyebrow>
          <h2 id="flow-title">
            Create the watch once.
            <br />
            Retrieve the evidence later.
          </h2>
        </div>
        <p>
          The caller does not have to stay alive
          <br />
          just to keep checking the chain.
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
                onClick={() => {
                  setSelected(index);
                  setInspected(true);
                }}
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
        <div className="flow-inspector">
          {flow.map((item, index) => (
            <div
              className="flow-detail"
              key={item.title}
              data-active={selected === index}
              aria-hidden={selected !== index}
            >
              <p className="inspector-stage mono">
                <span>Stage</span> 0{index + 1} / {item.title}
              </p>
              <dl className="inspector-context mono">
                <div>
                  <dt>Status</dt>
                  <dd>{item.status}</dd>
                </div>
                <div>
                  <dt>Boundary</dt>
                  <dd>{item.boundary}</dd>
                </div>
                <div>
                  <dt>Next</dt>
                  <dd>{item.next}</dd>
                </div>
              </dl>
              <p>{item.detail}</p>
            </div>
          ))}
        </div>
        <p role="status" className="sr-only">
          {inspected
            ? `Stage ${selected + 1}. ${flow[selected].title}. ${flow[selected].detail}`
            : ""}
        </p>
      </div>
    </section>
  );
}

function Technology() {
  const [inspected, setInspected] = useState<number | null>(null);
  const stages: {
    title: string;
    text: string;
    icon: IconName | null;
    className: string;
    checks: number[];
  }[] = [
    {
      title: "Caller",
      text: "Defines the exact payment",
      icon: "work",
      className: "",
      checks: [],
    },
    {
      title: "x402 service payment",
      text: "Purchases the bounded watch",
      icon: "code",
      className: "",
      checks: [0],
    },
    {
      title: "Algorand settlement",
      text: "Establishes service settlement",
      icon: "link",
      className: "",
      checks: [0, 1],
    },
    {
      title: "RoundWatch",
      text: "Activates, observes, persists",
      icon: null,
      className: "architecture-watch",
      checks: [1, 2, 3, 4, 5],
    },
    {
      title: "Verified future payment",
      text: "Exact match with transaction evidence",
      icon: "shield",
      className: "architecture-evidence",
      checks: [2, 5],
    },
  ];
  return (
    <section
      id="technology"
      className="section technology"
      data-reveal
      aria-labelledby="technology-title"
    >
      <Eyebrow number="04">Technology</Eyebrow>
      <h2 id="technology-title">
        Deterministic where it matters.
        <br />
        <span className="muted-heading">Intelligent where it helps.</span>
      </h2>
      <div className="technology-layout" data-inspecting={inspected !== null}>
        <div className="architecture-core">
          <p className="mono diagram-label">The deterministic core</p>
          <ol className="architecture-path">
            {stages.map((stage, index) => (
              <li
                key={stage.title}
                className={stage.className}
                data-active={inspected === index}
                data-connected={inspected === index || inspected === index + 1}
              >
                <button
                  className="architecture-stage"
                  aria-pressed={inspected === index}
                  onPointerEnter={(event) => {
                    if (event.pointerType !== "touch") setInspected(index);
                  }}
                  onFocus={() => setInspected(index)}
                  onClick={() => setInspected(index)}
                >
                  {stage.icon ? (
                    <Icon name={stage.icon} />
                  ) : (
                    <BrandMark orbital />
                  )}
                  <span>{stage.title}</span>
                  <small>{stage.text}</small>
                </button>
              </li>
            ))}
          </ol>
          <button
            className="architecture-next mono"
            aria-pressed={inspected === 5}
            data-active={inspected !== null && inspected >= 4}
            onPointerEnter={(event) => {
              if (event.pointerType !== "touch") setInspected(5);
            }}
            onFocus={() => setInspected(5)}
            onClick={() => setInspected(5)}
          >
            <Icon name="arrow" />
            Workflow continuation
          </button>
        </div>
        <div className="technology-copy">
          <h3>
            Evidence first.
            <br />
            Every next step, grounded.
          </h3>
          <p>
            Settlement and payment matching are established by deterministic
            infrastructure. A language model does not decide whether a payment
            settled or matched.
          </p>
          <ul className="capability-checks">
            {[
              "x402 service settlement",
              "Safe activation round",
              "Durable watch state",
              "Persistent scan cursor",
              "Restart recovery",
              "Exact future-payment matching",
            ].map((item, index) => (
              <li
                key={item}
                data-relevant={
                  inspected === 5
                    ? index === 2
                    : inspected !== null &&
                      stages[inspected].checks.includes(index)
                }
              >
                <Icon name="check" />
                {item}
              </li>
            ))}
          </ul>
          <p className="prototype-note">
            <span className="signal-dot" />
            Live and verified on Algorand MainNet.
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

function Ecosystem() {
  const identities = [
    { key: "product-hunt", name: "Product Hunt", relationship: "Launch platform" },
    { key: "openai", name: "OpenAI", relationship: "Model provider" },
    { key: "astra", name: "GPT-6 Astra", relationship: "Development tooling" },
    { key: "algorand", name: "Algorand", relationship: "MainNet settlement" },
    { key: "x402", name: "x402", relationship: "Payment protocol" },
  ] as const;
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
              {identities.map((identity) => (
                <span
                  className={`ribbon-word ${identity.key === "x402" ? "word-x402" : ""}`}
                  data-brand={identity.key}
                  key={identity.key}
                >
                  <span className="ribbon-identity">
                    {identity.name}
                    <small className="mono">{identity.relationship}</small>
                  </span>
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
  return (
    <MotionProvider>
      <Landing />
    </MotionProvider>
  );
}

function Landing() {
  const { reducedMotion, paused, hidden, togglePaused } = useMotion();
  useEffect(() => {
    if (reducedMotion || paused || !("IntersectionObserver" in window)) return;
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
  }, [reducedMotion, paused]);

  return (
    <div
      id="top"
      className="site"
      data-paused={paused || reducedMotion || hidden}
    >
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
                RoundWatch lets agents create a durable watch for one exact future
                Algorand payment, exit, and retrieve verified on-chain evidence
                later.
              </p>
              <div className="button-row">
                <ButtonLink href="#video-demo">See the demo</ButtonLink>
                <ButtonLink href="/start" secondary>
                  Start in 60 seconds
                </ButtonLink>
              </div>
              <p className="hero-proof mono">
                <i className="signal-dot" />
                Built on x402. Proven on Algorand MainNet.
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
                onClick={togglePaused}
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
              ["link", "MainNet verification", "Real settlements"],
              ["database", "Durable watch state", "Survives restarts"],
              ["shield", "Exact matching", "Evidence, not inference"],
              ["bolt", "Built for agents", "Caller can exit"],
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
          <VideoShowcase />
          <Flow />
          <Technology />
          <section
            id="workflow-replay"
            className="section demo"
            data-reveal
            aria-labelledby="replay-title"
          >
            <div className="section-heading">
              <div>
                <Eyebrow number="05">Lifecycle replay</Eyebrow>
                <h2 id="replay-title">
                  Follow the watch
                  <br />
                  from request to evidence.
                </h2>
              </div>
              <p>
                An illustrative replay of the verified MainNet lifecycle, one
                durable state transition at a time.
              </p>
            </div>
            <WorkflowReplay />
          </section>
          <Resilience />
          <section
            className="section why"
            data-reveal
            aria-labelledby="why-title"
          >
            <Eyebrow number="07">Why it matters</Eyebrow>
            <h2 id="why-title">
              A more reliable
              <br />
              agent economy.
            </h2>
            <div className="audiences">
              {[
                [
                  "For agents",
                  "The freedom to leave.",
                  "Create a durable wait, exit the process, and retrieve the exact payment evidence later.",
                  "01",
                ],
                [
                  "For services",
                  "A clearer payment boundary.",
                  "Separate caller lifetime from the infrastructure that owns observation and durable evidence.",
                  "02",
                ],
                [
                  "For developers",
                  "State that outlasts a process.",
                  "Use persisted watch state and scan progress instead of keeping a worker alive just to poll.",
                  "03",
                ],
              ].map(([label, title, copy, number]) => (
                <article
                  className="audience"
                  key={label}
                  tabIndex={0}
                  aria-labelledby={`audience-${number}`}
                >
                  <span className="mono audience-label">
                    {label}
                    <span>{number}</span>
                  </span>
                  <h3 id={`audience-${number}`}>{title}</h3>
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
                Durable watches
                <br />
                for on-chain events.
              </h2>
            </div>
            <div>
              <p className="challenge-marker mono">
                Built during the GPT-6 Astra Challenge
                <br />
                <span>Product Hunt · September 18, 2026</span>
              </p>
              <p>
                RoundWatch is a live MainNet service. GPT-6 Astra helped research,
                design, harden, and ship the system; deterministic infrastructure
                remains responsible for settlement and matching.
              </p>
              <p className="challenge-footnote">
                The challenge is launch context, not a runtime dependency or the
                reason the product exists.
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
              Create the watch.
              <br />
              <span>Let the workflow move on.</span>
            </h2>
            <div className="button-row">
              <ButtonLink href="#video-demo">View demo</ButtonLink>
              <ButtonLink href="/start" secondary>
                Start in 60 seconds
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
              Durable payment evidence
              <br />
              for autonomous work.
            </p>
          </div>
          <nav aria-label="Footer navigation">
            {navigation.map((item) => (
              <a href={item.href} key={item.href}>
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
