// 테스트 전용 헬퍼. 서버 코드에서 import하지 않는다.
import {
  createTurnResponseSchema,
  parseStreamEvent,
  type CreateTurnRequest,
  type StreamEvent,
} from '@stream-chat-lab/chat-protocol'
import { createSseParser } from '@stream-chat-lab/sse-parser'
import { createApp, DEMO_TOKEN } from './app'

export const auth = { Authorization: `Bearer ${DEMO_TOKEN}` }

export function setup(
  options: { seedMessageCount?: number; sleep?: (ms: number) => Promise<void> } = {},
) {
  let now = 0
  const drops: string[] = []
  const app = createApp({
    now: () => now,
    sleep: options.sleep ?? (() => Promise.resolve()),
    dropConnection: (turnId) => drops.push(turnId),
    seed: 1,
    seedMessageCount: options.seedMessageCount ?? 0,
  })
  return { app, drops, advance: (ms: number) => (now += ms) }
}

export type App = ReturnType<typeof setup>['app']

export async function createTurn(app: App, body: CreateTurnRequest) {
  const res = await app.request('/turns', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: res.ok ? createTurnResponseSchema.parse(await res.json()) : null }
}

export interface ReadResult {
  events: StreamEvent[]
  /** 이벤트마다 받은 SSE id */
  ids: string[]
  /** 본문이 끝까지 닫혔는가 (false면 읽는 쪽이 먼저 끊었다) */
  ended: boolean
  /** 받은 원문 (줄바꿈, 주석 확인용) */
  raw: string
}

/**
 * 스트림 본문을 M1 파서로 읽는다.
 * final을 받거나 stopAfter개를 받으면 읽기를 멈추고 연결을 끊는다.
 */
export async function readEvents(
  res: Response,
  options: { stopAfter?: number } = {},
): Promise<ReadResult> {
  const events: StreamEvent[] = []
  const ids: string[] = []
  const decoder = new TextDecoder()
  let raw = ''
  let stop = false
  const parser = createSseParser((e) => {
    if (stop) return
    const parsed = parseStreamEvent(e.data)
    if (!parsed.ok) throw new Error(`잘못된 이벤트: ${e.data}`)
    events.push(parsed.event)
    ids.push(e.id)
    if (parsed.event.type === 'final' || events.length === options.stopAfter) stop = true
  })
  if (!res.body) throw new Error('본문 없음')
  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      parser.end()
      return { events, ids, ended: true, raw: raw + decoder.decode() }
    }
    raw += decoder.decode(value, { stream: true })
    parser.push(value)
    if (stop) {
      await reader.cancel()
      return { events, ids, ended: false, raw }
    }
  }
}

export const types = (events: StreamEvent[]) => [...new Set(events.map((e) => e.type))]

export const tokenTexts = (events: StreamEvent[]) =>
  events.flatMap((e) => (e.type === 'token' ? [e.text] : []))
