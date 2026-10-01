import { randomUUID } from 'node:crypto'

export type ConsumeResult = 'ok' | 'invalid' | 'expired'

/**
 * 스트림 구독용 1회용 토큰. 네이티브 EventSource는 헤더를 못 넣어 URL 쿼리로 보내므로,
 * 노출 위험을 줄이려고 짧게 만료시키고 한 번만 쓸 수 있게 한다. (docs/protocol.md)
 */
export function createStreamTokenStore(options: { ttlMs: number; now: () => number }) {
  const tokens = new Map<string, { turnId: string; expiresAt: number }>()

  return {
    issue(turnId: string): string {
      const token = randomUUID()
      tokens.set(token, { turnId, expiresAt: options.now() + options.ttlMs })
      return token
    },
    consume(token: string, turnId: string): ConsumeResult {
      const entry = tokens.get(token)
      if (!entry || entry.turnId !== turnId) return 'invalid'
      tokens.delete(token)
      return options.now() > entry.expiresAt ? 'expired' : 'ok'
    },
  }
}
