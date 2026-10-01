import { parseStreamEvent } from '@stream-chat-lab/chat-protocol'
import type { StreamTransport } from './transport'

/**
 * 브라우저 네이티브 EventSource 어댑터. 파싱은 브라우저가 하고, data 해석만 직접 한다.
 *
 * - 헤더를 넣을 수 없어 1회용 토큰과 lastEventId를 쿼리로 보낸다. (docs/protocol.md)
 * - HTTP 상태 코드와 주석 하트비트는 볼 수 없다. (docs/decisions/012)
 */
export function createEventSourceTransport(baseUrl: string): StreamTransport {
  return {
    open(target, handlers) {
      const query = new URLSearchParams({ token: target.streamToken })
      if (target.lastEventId !== null) query.set('lastEventId', target.lastEventId)
      const source = new EventSource(
        `${baseUrl}/turns/${encodeURIComponent(target.turnId)}/stream?${query.toString()}`,
      )
      source.onmessage = (e: MessageEvent<string>) => {
        const result = parseStreamEvent(e.data)
        if (result.ok) handlers.onEvent(result.event, e.lastEventId)
        else handlers.onInvalid(e.data, result.reason)
      }
      source.onerror = () => handlers.onError({})
      return {
        close() {
          // 닫은 뒤에 큐에 남아 있던 이벤트가 오지 않도록 핸들러부터 뗀다.
          source.onmessage = null
          source.onerror = null
          source.close()
        },
      }
    },
  }
}
