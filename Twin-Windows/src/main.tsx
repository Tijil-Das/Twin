import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Disable default browser right-click context menu across the app
document.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary fallbackTitle="Application Failed to Load">
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
