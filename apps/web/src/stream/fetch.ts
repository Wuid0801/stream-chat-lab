import { parseStreamEvent } from '@stream-chat-lab/chat-protocol'
import { createSseParser } from '@stream-chat-lab/sse-parser'
import type { StreamErrorInfo, StreamTransport } from './transport'

export interface FetchTransportOptions {
  baseUrl: string
  /** 데모 인증 토큰. 헤더로 보내므로 URL에 1회용 토큰을 넣지 않는다. */
  token: string
  /** 이 시간 동안 아무 바이트(주석 하트비트 포함)도 오지 않으면 끊긴 것으로 본다. */
  idleTimeoutMs: number
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  setTimer?: (fn: () => void, ms: number) => number
  clearTimer?: (id: number) => void
}

/**
 * fetch + ReadableStream 어댑터. 파싱은 M1 파서(packages/sse-parser)가 한다.
 * EventSource와 달리 헤더 인증, HTTP 상태 코드, 주석 하트비트(바이트)를 볼 수 있다. (docs/decisions/012)
 */
export function createFetchTransport(options: FetchTransportOptions): StreamTransport {
  const fetchImpl = options.fetchImpl ?? ((url: string, init: RequestInit) => fetch(url, init))
  const setTimer = options.setTimer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms))
  const clearTimer = options.clearTimer ?? ((id: number) => window.clearTimeout(id))

  return {
    open(target, handlers) {
      const controller = new AbortController()
      let closed = false
      let timer: number | null = null

      const stopTimer = () => {
        if (timer !== null) clearTimer(timer)
        timer = null
      }
      /** 한 번만 알린다. close() 뒤에는 알리지 않는다. */
      const finish = (info: StreamErrorInfo) => {
        if (closed) return
        closed = true
        stopTimer()
        controller.abort()
        handlers.onError(info)
      }
      const armIdleTimer = () => {
        stopTimer()
        timer = setTimer(() => finish({ reason: 'idle-timeout' }), options.idleTimeoutMs)
      }

      const parser = createSseParser((e) => {
        if (closed) return
        const result = parseStreamEvent(e.data)
        if (result.ok) handlers.onEvent(result.event, e.id)
        else handlers.onInvalid(e.data, result.reason)
      })

      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.token}`,
        Accept: 'text/event-stream',
      }
      if (target.lastEventId !== null) headers['Last-Event-ID'] = target.lastEventId

      void (async () => {
        armIdleTimer()
        let res: Response
        try {
          res = await fetchImpl(
            `${options.baseUrl}/turns/${encodeURIComponent(target.turnId)}/stream`,
            { headers, signal: controller.signal },
          )
        } catch {
          finish({ reason: 'network' })
          return
        }
        if (!res.ok || !res.body) {
          finish({ status: res.status })
          return
        }
        const reader = res.body.getReader()
        try {
          for (;;) {
            const { value, done } = await reader.read()
            if (closed) return
            if (done) {
              parser.end()
              finish({ reason: 'closed' })
              return
            }
            armIdleTimer()
            parser.push(value)
          }
        } catch {
          finish({ reason: 'network' })
        }
      })()

      return {
        close() {
          if (closed) return
          closed = true
          stopTimer()
          controller.abort()
        },
      }
    },
  }
}
