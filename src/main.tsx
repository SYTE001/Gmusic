import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, AppErrorBoundary } from "./app/App";
import "./styles/base.css";

const container = document.getElementById("root");
if (!container) throw new Error("Root container missing");

createRoot(container).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>,
);
