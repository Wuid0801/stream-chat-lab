import {
  createTurnRequestSchema,
  type CreateTurnResponse,
  type StreamTokenResponse,
} from '@stream-chat-lab/chat-protocol'
import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { streamSSE } from 'hono/streaming'
import { createStore, toTurnResponse } from './store'
import { createStreamTokenStore } from './stream-tokens'
import { createTurnRuntime } from './turn-runtime'

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
  /** final 뒤에 연결을 유지하는 시간. 클라이언트가 먼저 닫는 것이 정상이다. */
  lingerMs?: number
}

/** Last-Event-ID 헤더(fetch) 또는 lastEventId 쿼리(EventSource). 없거나 잘못되면 0 */
function readLastEventId(c: Context): number {
  const raw = c.req.header('Last-Event-ID') ?? c.req.query('lastEventId') ?? ''
  const value = Number(raw)
  return /^\d+$/.test(raw) && Number.isSafeInteger(value) ? value : 0
}

export function createApp(options: AppOptions) {
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const baseSeed = options.seed ?? 1
  const store = createStore({
    now,
    seed: baseSeed,
    seedMessageCount: options.seedMessageCount ?? 40,
  })
  const streamTokens = createStreamTokenStore({ ttlMs: options.streamTokenTtlMs ?? 60_000, now })
  const runtime = createTurnRuntime({
    sleep,
    now,
    completeTurn: (turn, text, completion) => store.completeTurn(turn, text, completion),
    heartbeatMs: options.heartbeatMs ?? 15_000,
    lingerMs: options.lingerMs ?? 30_000,
  })
  let turnCount = 0

  const app = new Hono()
  app.use(
    '*',
    cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'Last-Event-ID'] }),
  )

  const hasDemoToken = (c: Context) => c.req.header('Authorization') === `Bearer ${DEMO_TOKEN}`
  const unauthorized = (c: Context, message = '인증이 필요하다') =>
    c.json({ code: 'unauthorized', message }, 401)
  const notFound = (c: Context) => c.json({ code: 'not-found', message: '턴이 없다' }, 404)

  app.get('/health', (c) => c.text('ok'))

  app.post('/turns', async (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const body = createTurnRequestSchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) return c.json({ code: 'bad-request', message: body.error.message }, 400)

    const { clientId, text, scenario = 'normal', scenarioOptions = {}, seed } = body.data
    const { replyTokens, tokensPerSecond } = body.data
    // 같은 clientId 재전송이 응답을 두 번 만들지 않게 한다. (docs/decisions/007, 013)
    const existing = store.findTurnByClientId(clientId)
    if (existing?.status === 'streaming') {
      return c.json({ code: 'turn-in-progress', message: '같은 clientId의 턴이 진행 중이다' }, 409)
    }
    if (existing?.status === 'failed') store.retryTurn(existing)
    const turn =
      existing ??
      store.createTurn({
        clientId,
        text,
        scenario,
        scenarioOptions,
        seed: seed ?? baseSeed + ++turnCount,
        replyOptions: {
          ...(replyTokens === undefined ? {} : { tokens: replyTokens }),
          ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
        },
      })
    const response: CreateTurnResponse = {
      turnId: turn.id,
      streamToken: streamTokens.issue(turn.id),
    }
    return c.json(response)
  })

  app.get('/turns/:id', (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return notFound(c)
    return c.json(toTurnResponse(turn))
  })

  // 이어 받기용 새 1회용 토큰 (docs/decisions/011)
  app.post('/turns/:id/stream-token', (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return notFound(c)
    const response: StreamTokenResponse = { streamToken: streamTokens.issue(turn.id) }
    return c.json(response)
  })

  // 사용자가 중지한다. 생성 중이면 거기까지의 응답을 저장한다. (docs/decisions/016)
  app.post('/turns/:id/cancel', (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return notFound(c)
    if (turn.status === 'streaming') runtime.cancel(turn)
    return c.json(toTurnResponse(turn))
  })

  app.get('/turns/:id/stream', (c) => {
    const turn = store.getTurn(c.req.param('id'))
    if (!turn) return notFound(c)
    // EventSource는 쿼리의 1회용 토큰으로, fetch 스트림은 헤더로 인증한다.
    if (!hasDemoToken(c)) {
      const result = streamTokens.consume(c.req.query('token') ?? '', turn.id)
      if (result !== 'ok') return unauthorized(c, `streamToken: ${result}`)
    }

    // 장애 시나리오는 첫 구독에만 적용한다. 재시도와 이어 받기는 성공할 수 있어야 한다.
    const firstSubscription = ++turn.subscriptions === 1
    if (firstSubscription && turn.scenario === 'http-401') {
      store.failTurn(turn)
      return unauthorized(c, '인증이 만료되었다')
    }
    if (firstSubscription && turn.scenario === 'http-5xx') {
      store.failTurn(turn)
      return c.json({ code: 'unavailable', message: '서버가 일시적으로 응답하지 않는다' }, 503)
    }

    let afterId = readLastEventId(c)
    // 완료된 턴을 처음부터 다시 구독하면(같은 clientId 재전송) 확정 결과만 보낸다.
    if (turn.status === 'completed' && afterId === 0) {
      afterId = Math.max(0, runtime.ensureStarted(turn).events.length - 1)
    }
    return streamSSE(c, (stream) =>
      runtime.subscribe(stream, turn, afterId, {
        firstSubscription,
        drop: () => options.dropConnection(turn.id, c),
      }),
    )
  })

  app.get('/messages', async (c) => {
    if (!hasDemoToken(c)) return unauthorized(c)
    // 측정(bench)에서 메시지 200개를 한 번에 불러오므로 최대 200개까지 준다.
    const limit = Math.min(Math.max(Number(c.req.query('limit') ?? 20) || 20, 1), 200)
    // out-of-order-history: 응답을 늦춰 스트림 확정과 도착 순서를 뒤바꾼다. 페이지는 응답하는 시점 기준이다.
    const delayMs = Math.min(Math.max(Number(c.req.query('delayMs') ?? 0) || 0, 0), 10_000)
    if (delayMs > 0) await sleep(delayMs)
    return c.json(store.page(c.req.query('cursor'), limit))
  })

  return app
}
