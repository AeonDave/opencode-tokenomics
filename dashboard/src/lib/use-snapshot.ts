import { useEffect, useState } from "react"
import type { GlobalSnapshot } from "./types"

/** Subscribe to the plugin's SSE stream; auto-reconnects on drop. */
export function useSnapshot(): { data: GlobalSnapshot | null; connected: boolean } {
  const [data, setData] = useState<GlobalSnapshot | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let es: EventSource | null = null
    let stopped = false
    let retry: ReturnType<typeof setTimeout> | undefined

    const connect = () => {
      es = new EventSource("/api/stream")
      es.onopen = () => setConnected(true)
      es.onmessage = (e) => {
        try {
          setData(JSON.parse(e.data) as GlobalSnapshot)
        } catch {
          /* ignore malformed frame */
        }
      }
      es.onerror = () => {
        setConnected(false)
        es?.close()
        // Reconnect quickly so a tab left open across an opencode restart re-attaches to the
        // fresh server before the plugin's auto-open grace window elapses (see index.ts).
        if (!stopped) retry = setTimeout(connect, 1000)
      }
    }
    connect()

    return () => {
      stopped = true
      es?.close()
      if (retry) clearTimeout(retry)
    }
  }, [])

  return { data, connected }
}
