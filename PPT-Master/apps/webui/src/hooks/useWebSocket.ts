import { useEffect, useRef, useState, useCallback } from "react"

export interface WSEvent {
  type: string
  gate?: string
  [key: string]: unknown
}

interface UseWebSocketOptions {
  sessionId: string | null
  onEvent?: (event: WSEvent) => void
  enabled?: boolean
  reconnectInterval?: number
}

export function useWebSocket({ sessionId, onEvent, enabled = true, reconnectInterval = 5000 }: UseWebSocketOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimer = useRef<ReturnType<typeof setTimeout>>()
  const [isConnected, setIsConnected] = useState(false)
  const [lastEvent, setLastEvent] = useState<WSEvent | null>(null)

  const connect = useCallback(() => {
    if (!sessionId || !enabled) return
    if (wsRef.current?.readyState === WebSocket.OPEN) return

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"

    // Append ?since=<id> cursor if we have a persisted last-event id for this
    // session. The backend skips events the FE already processed in a prior
    // connection, preventing re-delivery of terminal events (e.g. agent_error).
    const cursorKey = `ws-cursor-${sessionId}`
    const lastSeenId = sessionStorage.getItem(cursorKey)
    const url = lastSeenId
      ? `${protocol}//${window.location.host}/ws/sessions/${sessionId}?since=${encodeURIComponent(lastSeenId)}`
      : `${protocol}//${window.location.host}/ws/sessions/${sessionId}`
    const ws = new WebSocket(url)

    ws.onopen = () => {
      setIsConnected(true)
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current)
        reconnectTimer.current = undefined
      }
    }

    // Dedup: skip events already received during replay→live overlap
    const seenIds = new Set<string>()

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as WSEvent & { _id?: string }
        if (data._id) {
          if (seenIds.has(data._id)) return
          seenIds.add(data._id)
          // Persist cursor so reconnects skip already-processed events
          try {
            sessionStorage.setItem(cursorKey, data._id)
          } catch {
            // Storage quota exceeded — non-fatal
          }
        }
        setLastEvent(data)
        onEvent?.(data)
      } catch {
        // Non-JSON message, ignore
      }
    }

    ws.onclose = () => {
      setIsConnected(false)
      wsRef.current = null
      if (enabled) {
        reconnectTimer.current = setTimeout(connect, reconnectInterval)
      }
    }

    ws.onerror = () => {
      ws.close()
    }

    wsRef.current = ws
  }, [sessionId, enabled, onEvent, reconnectInterval])

  useEffect(() => {
    connect()
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current)
      wsRef.current?.close()
      wsRef.current = null
    }
  }, [connect])

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data))
    }
  }, [])

  return { isConnected, lastEvent, send, reconnect: connect }
}
