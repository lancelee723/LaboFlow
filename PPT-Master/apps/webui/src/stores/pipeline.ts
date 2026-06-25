import { useSyncExternalStore } from "react"
import { create } from "zustand"

export interface SvgProgress {
  page: number
  total: number
}

interface PipelineState {
  // Existing nav-guard (preserved from Spec 1)
  isActive: boolean
  pendingNav: (() => void) | null
  setActive: (v: boolean) => void
  requestLeave: (proceed: () => void) => void
  clearPendingNav: () => void

  // Canonical pipeline state (consolidated from ProjectEditorPage locals — closes A1-1, A1-2, C2-1, C6-1)
  isRunning: boolean
  pipelineStep: number
  activeGate: string | null
  svgProgress: SvgProgress | null
  recoveryStep: number
  recoveryCompleted: number[]

  setIsRunning: (v: boolean) => void
  setPipelineStep: (n: number) => void
  setActiveGate: (g: string | null) => void
  setSvgProgress: (p: SvgProgress | null) => void
  setRecoveryStep: (n: number) => void
  setRecoveryCompleted: (n: number[]) => void

  // G4.9: Token counter (per-session, resets on new pipeline)
  tokenIn: number
  tokenOut: number
  addTokens: (tin: number, tout: number) => void
  resetTokens: () => void

  // Composite reset (closes C2-1)
  resetWorkspace: () => void
}

export const usePipelineStore = create<PipelineState>((set) => ({
  // Nav-guard
  isActive: false,
  pendingNav: null,
  setActive: (v) => set({ isActive: v }),
  requestLeave: (proceed) => set({ pendingNav: proceed }),
  clearPendingNav: () => set({ pendingNav: null }),

  // Canonical pipeline state
  isRunning: false,
  pipelineStep: 0,
  activeGate: null,
  svgProgress: null,
  recoveryStep: 0,
  recoveryCompleted: [],

  setIsRunning: (v) => set({ isRunning: v }),
  setPipelineStep: (n) => set({ pipelineStep: n }),
  setActiveGate: (g) => set({ activeGate: g }),
  setSvgProgress: (p) => set({ svgProgress: p }),
  setRecoveryStep: (n) => set({ recoveryStep: n }),
  setRecoveryCompleted: (n) => set({ recoveryCompleted: n }),

  // G4.9: Token counter
  tokenIn: 0,
  tokenOut: 0,
  addTokens: (tin, tout) => set((s) => ({ tokenIn: s.tokenIn + tin, tokenOut: s.tokenOut + tout })),
  resetTokens: () => set({ tokenIn: 0, tokenOut: 0 }),

  resetWorkspace: () => set({
    isRunning: false,
    svgProgress: null,
    activeGate: null,
    recoveryStep: 0,
    recoveryCompleted: [],
    tokenIn: 0,
    tokenOut: 0,
  }),
}))

/**
 * Hook equivalent to usePipelineStore(selector) but uses getState() as the
 * server snapshot so that renderToStaticMarkup tests see post-setState values.
 *
 * Zustand's built-in hook uses getInitialState() as the SSR snapshot, which
 * always returns the creation-time state regardless of setState() calls.
 * This hook overrides that behaviour so SSR-based unit tests work correctly.
 */
export function usePipelineStoreSSR<T>(selector: (s: PipelineState) => T): T {
  return useSyncExternalStore(
    usePipelineStore.subscribe,
    () => selector(usePipelineStore.getState()),
    () => selector(usePipelineStore.getState()),
  )
}
