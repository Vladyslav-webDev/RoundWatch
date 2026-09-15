import App from "./App";
import { LegalFooterBar, LegalPage } from "./Legal";

type RootAppProps = {
  path?: string;
};

export default function RootApp({ path }: RootAppProps) {
  const pathname =
    path ?? (typeof window !== "undefined" ? window.location.pathname : "/");

  if (pathname === "/impressum" || pathname === "/impressum/") {
    return <LegalPage kind="impressum" />;
  }

  if (pathname === "/privacy" || pathname === "/privacy/") {
    return <LegalPage kind="privacy" />;
  }

  return (
    <>
      <App />
      <LegalFooterBar />
    </>
  );
}
