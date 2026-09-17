import App from "./App";
import { LegalFooterBar, LegalPage } from "./Legal";
import QuickstartPage from "./Quickstart";

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

  if (pathname === "/start" || pathname === "/start/") {
    return (
      <>
        <QuickstartPage />
        <LegalFooterBar />
      </>
    );
  }

  return (
    <>
      <App />
      <LegalFooterBar />
    </>
  );
}
