import React from "react";
import ReactDOM from "react-dom/client";
import RootApp from "./RootApp";
import "./styles.css";
import "./interaction.css";
import "./legal.css";
import "./launch-polish.css";
import "./system-map.css";
import "./payment-guide.css";

const root = document.getElementById("root")!;
const app = (
  <React.StrictMode>
    <RootApp path={window.location.pathname} />
  </React.StrictMode>
);

if (root.hasChildNodes()) {
  ReactDOM.hydrateRoot(root, app);
} else {
  ReactDOM.createRoot(root).render(app);
}
