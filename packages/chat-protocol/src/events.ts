import { z } from 'zod'
import { messageSchema } from './messages'

/**
 * 스트림 이벤트. SSE의 event 필드는 쓰지 않고(기본 'message'), data JSON의 type으로 구분한다.
 * event 이름 'error'가 EventSource의 연결 오류 이벤트와 겹치기 때문이다. (docs/decisions/004)
 */
export const streamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('token'),
    turnId: z.string(),
    seq: z.number().int(),
    text: z.string(),
  }),
  /** 생성이 끝났다는 알림일 뿐 종료 신호가 아니다. 이 뒤에 final이 온다. */
  z.object({ type: z.literal('done'), turnId: z.string() }),
  /** 유일한 정상 종료 신호. 서버에 확정된 메시지를 담는다. */
  z.object({
    type: z.literal('final'),
    turnId: z.string(),
    userMessage: messageSchema,
    assistantMessage: messageSchema,
  }),
  /** 서버가 알려 주는 실패. 실패로 종료한다. */
  z.object({ type: z.literal('error'), turnId: z.string(), code: z.string(), message: z.string() }),
])
export type StreamEvent = z.infer<typeof streamEventSchema>

export type ParseResult = { ok: true; event: StreamEvent } | { ok: false; reason: string }

export function parseStreamEvent(data: string): ParseResult {
  let json: unknown
  try {
    json = JSON.parse(data)
  } catch {
    return { ok: false, reason: 'invalid-json' }
  }
  const result = streamEventSchema.safeParse(json)
  return result.success
    ? { ok: true, event: result.data }
    : { ok: false, reason: result.error.message }
}

/** 이 이벤트를 받으면 턴이 끝난다. final(성공)과 error(실패)뿐이다. */
export function isTerminalEvent(event: StreamEvent): boolean {
  return event.type === 'final' || event.type === 'error'
}
