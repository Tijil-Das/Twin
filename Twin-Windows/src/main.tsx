import React, { Component, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("App Crash:", error, errorInfo);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 32, color: "#ef4444", fontFamily: "sans-serif" }}>
          <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>Rendering Error</h2>
          <pre style={{ background: "#1e2024", padding: 16, borderRadius: 8, overflow: "auto", fontSize: 12 }}>
            {this.state.error.stack || this.state.error.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 16, padding: "8px 16px", background: "#3b82f6", color: "white", borderRadius: 6, border: "none", cursor: "pointer" }}
          >
            Reload Window
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element not found");
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);
