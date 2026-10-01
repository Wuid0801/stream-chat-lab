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
  'drop-mid-stream',
  'slow-first-token',
  'long-silence',
  'http-401',
  'http-5xx',
  'chunk-chaos',
  'proxy-buffering',
])
export type Scenario = z.infer<typeof scenarioSchema>

/**
 * 시나리오의 시간 값. 기본값은 DEMO_SPEC 4장 그대로이고, E2E는 짧게 줄여서 쓴다.
 */
export const scenarioOptionsSchema = z.object({
  /** slow-first-token: 첫 토큰까지 기다리는 시간 (기본: seed로 5~15초) */
  firstTokenDelayMs: z.number().int().min(0).max(120_000).optional(),
  /** long-silence: 응답 중간의 침묵 시간 (기본 60초) */
  silenceMs: z.number().int().min(0).max(300_000).optional(),
  /** 주석 하트비트(`: ping`)를 보낼지 (기본 true) */
  heartbeat: z.boolean().optional(),
  /** 하트비트 간격 (기본 15초) */
  heartbeatMs: z.number().int().min(50).max(60_000).optional(),
  /** proxy-buffering: 모아서 보내는 간격 (기본 2초) */
  bufferMs: z.number().int().min(10).max(60_000).optional(),
})
export type ScenarioOptions = z.infer<typeof scenarioOptionsSchema>

export const createTurnRequestSchema = z.object({
  clientId: z.string().min(1),
  text: z.string().min(1),
  scenario: scenarioSchema.optional(),
  scenarioOptions: scenarioOptionsSchema.optional(),
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

/** POST /turns/:id/stream-token: 이어 받기용 새 1회용 토큰 */
export const streamTokenResponseSchema = z.object({ streamToken: z.string() })
export type StreamTokenResponse = z.infer<typeof streamTokenResponseSchema>

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
