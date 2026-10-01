import {
  createTurnRequestSchema,
  type CreateTurnResponse,
  type StreamEvent,
} from '@stream-chat-lab/chat-protocol'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE, type SSEStreamingApi } from 'hono/streaming'
import { generateReply } from './reply'
import { createStore, toTurnResponse, type TurnRecord } from './store'
import { createStreamTokenStore } from './stream-tokens'

/** 데모용 고정 인증 토큰. 실제 인증 흐름은 이 저장소의 범위가 아니다. */
export const DEMO_TOKEN = 'demo-token'

export interface AppOptions {
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** TCP 연결을 강제로 끊는다. 런타임마다 방법이 달라서 주입받는다. */
  dropConnection: (turnId: string, c: Context) => void
  seed?: number
  seedMessageCount?: number
  streamTokenTtlMs?: number
  heartbeatMs?: number
  /** normal 시나리오에서 final 뒤에 연결을 유지하는 시간. 클라이언트가 먼저 닫는 것이 정상이다. */
  lingerMs?: number
}

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const heartbeatMs = options.heartbeatMs ?? 15_000
  const lingerMs = options.lingerMs ?? 30_000
  const baseSeed = options.seed ?? 1
  const store = createStore({
    now,
    seed: baseSeed,
    seedMessageCount: options.seedMessageCount ?? 40,
  })
  const streamTokens = createStreamTokenStore({ ttlMs: options.streamTokenTtlMs ?? 60_000, now })
  let turnCount = 0

  const app = new Hono()
  app.use('*', cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type'] }))

  const hasDemoToken = (c: Context) => c.req.header('Authorization') === `Bearer ${DEMO_TOKEN}`
  const unauthorized = (c: Context, message = '인증이 필요하다') =>
    c.json({ code: 'unauthorized', message }, 401)

  app.get('/health', (c) => c.text('ok'))

  app.post('/turns', async (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const body = createTurnRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ code: 'bad-request', message: body.error.message }, 400)

    const { clientId, text, scenario = 'normal', seed } = body.data
    // 같은 clientId 재전송이 응답을 두 번 만들지 않게 한다. (docs/decisions/007)
    const existing = store.findTurnByClientId(clientId)
    if (existing?.status === 'streaming') {
      return c.json({ code: 'turn-in-progress', message: '같은 clientId의 턴이 진행 중이다' }, 409)
    }
    const turn =
      existing ??
      store.createTurn({ clientId, text, scenario, seed: seed ?? baseSeed + ++turnCount })
    const response: CreateTurnResponse = {
      turnId: turn.id,
      streamToken: streamTokens.issue(turn.id),
    }
    return c.json(response)
  })

  app.get('/turns/:id', (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return c.json({ code: 'not-found', message: '턴이 없다' }, 404)
    return c.json(toTurnResponse(turn))
  })

  app.get('/turns/:id/stream', (c) => {
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return c.json({ code: 'not-found', message: '턴이 없다' }, 404)
    // EventSource는 쿼리의 1회용 토큰으로, fetch 스트림은 헤더로 인증한다.
    if (!hasDemoToken(c)) {
      const result = streamTokens.consume(c.req.query('token') ?? '', turn.id)
      if (result !== 'ok') return unauthorized(c, `streamToken: ${result}`)
    }
    return streamSSE(c, (stream) => runTurn(stream, turn, c))
  })

  app.get('/messages', (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 100)
    return c.json(store.page(c.req.query('cursor'), limit))
  })

  async function runTurn(stream: SSEStreamingApi, turn: TurnRecord, c: Context): Promise<void> {
    const send = (event: StreamEvent) => stream.writeSSE({ data: JSON.stringify(event) })
    const sendFinal = () => {
      if (!turn.assistantMessage) throw new Error('완료되지 않은 턴')
      return send({
        type: 'final',
        turnId: turn.id,
        userMessage: turn.userMessage,
        assistantMessage: turn.assistantMessage,
      })
    }

    // 이미 완료된 턴을 다시 구독하면 확정 결과만 보낸다.
    if (turn.status === 'completed') {
      await sendFinal()
      return
    }

    const reply = generateReply(turn.seed)
    for (const [seq, text] of reply.tokens.entries()) {
      if (stream.aborted) break
      await send({ type: 'token', turnId: turn.id, seq, text })
      await sleep(reply.intervalMs)
    }
    // 클라이언트가 중간에 끊어도 서버는 생성을 끝까지 마치고 저장한다.
    store.completeTurn(turn, reply.tokens.join(''))
    if (stream.aborted) return

    switch (turn.scenario) {
      case 'normal':
        await send({ type: 'done', turnId: turn.id })
        await sendFinal()
        // 연결을 닫는 쪽은 클라이언트다. 그동안 주석 하트비트를 보낸다.
        for (let waited = 0; waited < lingerMs && !stream.aborted; waited += heartbeatMs) {
          await sleep(heartbeatMs)
          if (!stream.aborted) await stream.write(': ping\n\n')
        }
        return
      case 'done-only':
        // 계약 위반: final 없이 닫는다.
        await send({ type: 'done', turnId: turn.id })
        return
      case 'close-after-final':
        await send({ type: 'done', turnId: turn.id })
        await sendFinal()
        return
      case 'drop-after-saved':
        // 서버 저장은 끝났지만 done/final을 보내기 직전에 TCP 연결이 끊긴다.
        options.dropConnection(turn.id, c)
        return
    }
  }

  return app
}
