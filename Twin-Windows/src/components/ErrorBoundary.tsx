import React, { Component, type ReactNode } from "react";
import { AlertTriangle, RotateCcw, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "./ui/button";

interface Props {
  children: ReactNode;
  fallbackTitle?: string;
  onReset?: () => void;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
  detailsOpen: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    error: null,
    errorInfo: null,
    detailsOpen: false,
  };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught:", error, errorInfo);
    this.setState({ errorInfo });
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
    this.props.onReset?.();
  };

  render() {
    if (this.state.hasError) {
      const { fallbackTitle = "Something went wrong in this view" } = this.props;
      const { error, errorInfo, detailsOpen } = this.state;

      return (
        <div className="flex flex-col items-center justify-center p-8 min-h-[300px] text-center max-w-lg mx-auto">
          <div className="w-12 h-12 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center text-red-400 mb-4 shadow-sm">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <h2 className="text-base font-bold text-white mb-1.5">{fallbackTitle}</h2>
          <p className="text-xs text-[#7d8590] mb-5 leading-relaxed">
            The view encountered an unexpected runtime error. You can recover by retrying or switching screens.
          </p>

          <div className="flex items-center gap-2.5 mb-4">
            <Button
              onClick={this.handleReset}
              variant="outline"
              size="sm"
              className="text-xs flex items-center gap-1.5 border-[#30363d] hover:bg-[#21262d] text-white"
            >
              <RotateCcw className="w-3.5 h-3.5 text-blue-400" />
              Try Recovering
            </Button>
            <Button
              onClick={() => window.location.reload()}
              variant="outline"
              size="sm"
              className="text-xs flex items-center gap-1.5 border-[#30363d] hover:bg-[#21262d] text-[#8b949e]"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload App
            </Button>
          </div>

          {error && (
            <div className="w-full text-left mt-2">
              <button
                type="button"
                onClick={() => this.setState({ detailsOpen: !detailsOpen })}
                className="text-[11px] text-[#7d8590] hover:text-[#c9d1d9] flex items-center gap-1 mx-auto transition-colors"
              >
                <span>{detailsOpen ? "Hide diagnostic details" : "Show diagnostic details"}</span>
                {detailsOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              </button>
              {detailsOpen && (
                <div className="mt-3 p-3 rounded-lg bg-[#161b22] border border-[#30363d] text-[11px] font-mono text-red-300 overflow-x-auto max-h-48 whitespace-pre-wrap leading-tight">
                  <div className="font-semibold text-red-400 mb-1">{error.name}: {error.message}</div>
                  {error.stack && <div className="text-[#8b949e]">{error.stack}</div>}
                  {errorInfo?.componentStack && (
                    <div className="mt-2 pt-2 border-t border-[#30363d]/60 text-[#7d8590]">
                      {errorInfo.componentStack}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}
