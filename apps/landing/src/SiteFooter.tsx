import { BrandMark } from "./graphics";

const footerNavigation = [
  { label: "Product", href: "#product" },
  { label: "Quickstart", href: "/start" },
  { label: "Technology", href: "#technology" },
  { label: "Demo", href: "#video-demo" },
] as const;

export function SiteFooter({ rootedLinks = false }: { rootedLinks?: boolean }) {
  const resolveHref = (href: string) =>
    rootedLinks && href.startsWith("#") ? `/${href}` : href;

  return (
    <footer className="site-footer container">
      <div className="footer-top">
        <div>
          <a
            className="brand"
            href={rootedLinks ? "/" : "#top"}
            aria-label="RoundWatch home"
          >
            <BrandMark orbital />
            <span>RoundWatch</span>
          </a>
          <p>
            Durable payment evidence
            <br />
            for autonomous work.
          </p>
        </div>

        <nav aria-label="Footer navigation">
          {footerNavigation.map((item) => (
            <a href={resolveHref(item.href)} key={item.href}>
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
  );
}
