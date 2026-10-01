export interface TokenBatcherOptions {
  onFlush(clientId: string, text: string): void
  requestFrame(callback: () => void): number
  cancelFrame(id: number): void
}

/**
 * 토큰을 프레임 단위로 모아 한 번에 내보낸다.
 * 스트림 이벤트는 각각 별도 task로 오므로 React가 묶어 준다는 보장이 없다. (LEARNING.md 7장)
 */
export function createTokenBatcher(options: TokenBatcherOptions) {
  let clientId: string | null = null
  let text = ''
  let frame = 0

  function flush(): void {
    if (frame) options.cancelFrame(frame)
    frame = 0
    if (clientId === null || text === '') return
    const id = clientId
    const batch = text
    text = ''
    options.onFlush(id, batch)
  }

  return {
    push(id: string, token: string): void {
      // 다른 턴의 토큰이 섞이지 않게 앞 턴의 남은 토큰을 먼저 내보낸다.
      if (clientId !== null && clientId !== id) flush()
      clientId = id
      text += token
      if (!frame) frame = options.requestFrame(flush)
    },
    /** final이나 실패를 반영하기 직전에 부른다. 백그라운드 탭에서는 rAF가 멈추기 때문이다. */
    flush,
    /** 언마운트 시 부른다. 예약을 취소하고 남은 토큰을 버린다. */
    dispose(): void {
      if (frame) options.cancelFrame(frame)
      frame = 0
      clientId = null
      text = ''
    },
  }
}

export type TokenBatcher = ReturnType<typeof createTokenBatcher>
