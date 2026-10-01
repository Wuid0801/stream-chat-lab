import { parseStreamEvent } from '@stream-chat-lab/chat-protocol'
import type { StreamTransport } from './transport'

/** 브라우저 네이티브 EventSource 어댑터. 파싱은 브라우저가 하고, data 해석만 직접 한다. */
export const eventSourceTransport: StreamTransport = {
  open(url, handlers) {
    const source = new EventSource(url)
    source.onmessage = (e: MessageEvent<string>) => {
      const result = parseStreamEvent(e.data)
      if (result.ok) handlers.onEvent(result.event)
      else handlers.onInvalid(e.data, result.reason)
    }
    source.onerror = () => handlers.onError()
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
