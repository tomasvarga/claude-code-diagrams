// A rendered picture of a diagram: the PNG's path and its size in pixels.
export type Picture = { path: string; width: number; height: number }

export type Diagram = { title: string; source: string; mermaid?: string; picture?: Picture }

declare module 'claude-code' {
  interface PluginState {
    diagrams: {
      list: Diagram[]
      index: number
      isOpen: boolean
      reveal: number
      pan: number
      zoomedBy: string
      isFull: boolean
      isText: boolean
      pulse: number
    }
  }
}
