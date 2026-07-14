import { Component, type ErrorInfo, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  failed: boolean
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep diagnostics local. The app does not ship a telemetry pipeline.
    console.error('Nerion renderer failed', error, info.componentStack)
  }

  private reload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children

    return (
      <main className="app-shell flex h-screen items-center justify-center px-6 text-zinc-100">
        <section role="alert" className="glass-panel flex max-w-sm flex-col items-center gap-3 rounded-2xl p-6 text-center">
          <h1 className="text-sm font-semibold text-zinc-100">Nerion ran into a display problem</h1>
          <p className="text-xs leading-relaxed text-zinc-400">
            Your files were not changed. Reload the window to continue.
          </p>
          <button
            type="button"
            onClick={this.reload}
            className="rounded-lg bg-blue-600 px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-500"
          >
            Reload Nerion
          </button>
        </section>
      </main>
    )
  }
}
