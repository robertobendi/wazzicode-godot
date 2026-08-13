import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AmbientBackdrop from "./components/shell/AmbientBackdrop";
import AppErrorBoundary from "./components/shell/AppErrorBoundary";
import { primeTheme } from "./lib/theme";
import "./styles/globals.css";

primeTheme();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <AmbientBackdrop />
      <App />
    </AppErrorBoundary>
  </React.StrictMode>,
);
