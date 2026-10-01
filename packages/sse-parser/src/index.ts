/**
 * 프레임워크와 무관한 SSE 스트리밍 파서.
 * 규칙은 WHATWG HTML 표준의 "event stream interpretation"을 따른다.
 */

export interface SseEvent {
  /** event 필드 값. 없으면 'message' */
  event: string
  /** data 줄들을 \n으로 합친 값 */
  data: string
  /** 지금까지 받은 마지막 id (표준의 last event ID). 이벤트를 넘어 유지되고, 없으면 '' */
  id: string
  /** 지금까지 받은 마지막 유효한 retry 값(ms). 이벤트를 넘어 유지되고, 없으면 undefined */
  retry: number | undefined
}

export interface SseParser {
  /** 바이트 청크를 넣는다. 청크 경계는 이벤트·줄·UTF-8 문자 경계와 무관해도 된다. */
  push(chunk: Uint8Array): void
  /** 스트림이 끝났을 때 한 번 호출한다. 빈 줄로 끝나지 않은 마지막 조각은 버린다. */
  end(): void
}

export function createSseParser(onEvent: (event: SseEvent) => void): SseParser {
  // 기본 설정(ignoreBOM: false)의 TextDecoder가 스트림 맨 앞 BOM을 한 번 제거한다.
  // 바이트 단위로 쪼개진 BOM도 stream 모드에서 이월되어 처리된다.
  const decoder = new TextDecoder()
  let buffer = ''
  let lastEventId = ''
  let retry: number | undefined

  function processBlock(block: string): void {
    let eventType = ''
    const dataLines: string[] = []

    for (const line of block.split('\n')) {
      if (line === '' || line.startsWith(':')) continue

      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)

      switch (field) {
        case 'event':
          eventType = value
          break
        case 'data':
          dataLines.push(value)
          break
        case 'id':
          if (!value.includes('\u0000')) lastEventId = value
          break
        case 'retry':
          if (/^\d+$/.test(value)) retry = Number(value)
          break
      }
    }

    // data 줄이 하나도 없으면 내보내지 않는다. (id, retry 반영은 위에서 이미 끝났다)
    if (dataLines.length === 0) return
    onEvent({ event: eventType || 'message', data: dataLines.join('\n'), id: lastEventId, retry })
  }

  /** 줄바꿈을 \n으로 통일하고 빈 줄로 잘라, 완성된 이벤트를 처리한 뒤 미완성 조각을 돌려준다. */
  function drain(text: string): string {
    const parts = text.replace(/\r\n?/g, '\n').split('\n\n')
    const rest = parts.pop() ?? ''
    for (const block of parts) processBlock(block)
    return rest
  }

  return {
    push(chunk) {
      buffer += decoder.decode(chunk, { stream: true })
      // 끝의 \r은 다음 청크의 \n과 짝(\r\n)일 수 있으니 통일하지 않고 남겨 둔다.
      const cut = buffer.endsWith('\r') ? buffer.length - 1 : buffer.length
      buffer = drain(buffer.slice(0, cut)) + buffer.slice(cut)
    },
    end() {
      // 디코더에 남은 바이트와 남겨 둔 \r까지 포함해 한 번 더 처리한다.
      // (스트림이 "\r\r"로 끝나면 push 단계에서는 마지막 이벤트가 대기 상태로 남는다)
      drain(buffer + decoder.decode())
      buffer = ''
    },
  }
}
