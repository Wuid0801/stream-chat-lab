import { z } from 'zod'

/** 서버에 저장된 메시지. clientId는 클라이언트가 만든 id를 서버가 그대로 돌려준 값이다. */
export const messageSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  createdAt: z.string(),
})
export type Message = z.infer<typeof messageSchema>

/** 응답 메시지의 clientId는 사용자 메시지의 clientId로 정해진다. 서버와 클라이언트가 같은 규칙을 쓴다. */
export function replyClientId(userClientId: string): string {
  return `${userClientId}:reply`
}

/** 목 서버 장애 시나리오. docs/protocol.md 참고 */
export const scenarioSchema = z.enum([
  'normal',
  'done-only',
  'close-after-final',
  'drop-after-saved',
])
export type Scenario = z.infer<typeof scenarioSchema>

export const createTurnRequestSchema = z.object({
  clientId: z.string().min(1),
  text: z.string().min(1),
  scenario: scenarioSchema.optional(),
  seed: z.number().int().optional(),
  /** 측정용: 응답 토큰 수 (기본: seed로 정함) */
  replyTokens: z.number().int().min(1).max(10_000).optional(),
  /** 측정용: 초당 토큰 수 (기본: seed로 20~60 사이에서 정함) */
  tokensPerSecond: z.number().positive().max(1000).optional(),
})
export type CreateTurnRequest = z.infer<typeof createTurnRequestSchema>

export const createTurnResponseSchema = z.object({
  turnId: z.string(),
  streamToken: z.string(),
})
export type CreateTurnResponse = z.infer<typeof createTurnResponseSchema>

export const turnStatusSchema = z.enum(['streaming', 'completed', 'failed'])
export type TurnStatus = z.infer<typeof turnStatusSchema>

export const turnResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  status: turnStatusSchema,
  userMessage: messageSchema,
  assistantMessage: messageSchema.nullable(),
})
export type TurnResponse = z.infer<typeof turnResponseSchema>

export const messagesPageSchema = z.object({
  /** 오래된 것 → 최신 순 */
  messages: z.array(messageSchema),
  /** 더 오래된 페이지를 가리키는 커서. 없으면 null */
  nextCursor: z.string().nullable(),
})
export type MessagesPage = z.infer<typeof messagesPageSchema>
