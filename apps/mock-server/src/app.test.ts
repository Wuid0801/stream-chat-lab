import {
  createTurnResponseSchema,
  messagesPageSchema,
  parseStreamEvent,
  turnResponseSchema,
  type Scenario,
  type StreamEvent,
} from '@stream-chat-lab/chat-protocol'
import { createSseParser } from '@stream-chat-lab/sse-parser'
import { describe, expect, it } from 'vitest'
import { createApp, DEMO_TOKEN } from './app'

const auth = { Authorization: `Bearer ${DEMO_TOKEN}` }

function setup(options: { seedMessageCount?: number } = {}) {
  let now = 0
  const drops: string[] = []
  const app = createApp({
    now: () => now,
    sleep: () => Promise.resolve(),
    dropConnection: (turnId) => drops.push(turnId),
    seed: 1,
    seedMessageCount: options.seedMessageCount ?? 0,
  })
  return { app, drops, advance: (ms: number) => (now += ms) }
}

type App = ReturnType<typeof setup>['app']

async function createTurn(
  app: App,
  body: { clientId: string; text: string; scenario?: Scenario; seed?: number },
) {
  const res = await app.request('/turns', {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { res, json: res.ok ? createTurnResponseSchema.parse(await res.json()) : null }
}

/** 스트림 본문을 M1 파서로 읽는다. final을 받으면 읽기를 멈추고 연결을 끊는다. */
async function readEvents(res: Response): Promise<{ events: StreamEvent[]; ended: boolean }> {
  const events: StreamEvent[] = []
  let gotFinal = false
  const parser = createSseParser((e) => {
    const parsed = parseStreamEvent(e.data)
    if (!parsed.ok) throw new Error(`잘못된 이벤트: ${e.data}`)
    events.push(parsed.event)
    if (parsed.event.type === 'final') gotFinal = true
  })
  if (!res.body) throw new Error('본문 없음')
  const reader = res.body.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) {
      parser.end()
      return { events, ended: true }
    }
    parser.push(value)
    if (gotFinal) {
      await reader.cancel()
      return { events, ended: false }
    }
  }
}

async function runScenario(scenario: Scenario, seed = 7) {
  const ctx = setup()
  const { json } = await createTurn(ctx.app, { clientId: 'c-1', text: '안녕', scenario, seed })
  if (!json) throw new Error('턴 생성 실패')
  const res = await ctx.app.request(`/turns/${json.turnId}/stream?token=${json.streamToken}`)
  const { events, ended } = await readEvents(res)
  const turnRes = await ctx.app.request(`/turns/${json.turnId}`, { headers: auth })
  const turn = turnResponseSchema.parse(await turnRes.json())
  return { ...ctx, res, events, ended, turn, turnId: json.turnId }
}

const types = (events: StreamEvent[]) => [...new Set(events.map((e) => e.type))]

it('GET /health는 인증 없이 200 (E2E 준비 확인용)', async () => {
  const { app } = setup()
  expect((await app.request('/health')).status).toBe(200)
})

describe('인증', () => {
  it('Bearer 토큰 없이 턴을 만들면 401', async () => {
    const { app } = setup()
    const res = await app.request('/turns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'c-1', text: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  it('streamToken은 한 번만 쓸 수 있다', async () => {
    const { app } = setup()
    const { json } = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    const url = `/turns/${json?.turnId}/stream?token=${json?.streamToken}`
    await readEvents(await app.request(url))
    expect((await app.request(url)).status).toBe(401)
  })

  it('만료된 streamToken은 401', async () => {
    const { app, advance } = setup()
    const { json } = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    advance(60_001)
    const res = await app.request(`/turns/${json?.turnId}/stream?token=${json?.streamToken}`)
    expect(res.status).toBe(401)
  })

  it('스트림은 Authorization 헤더로도 구독할 수 있다 (fetch 어댑터용)', async () => {
    const { app } = setup()
    const { json } = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    const res = await app.request(`/turns/${json?.turnId}/stream`, { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    await res.body?.cancel()
  })
})

describe('시나리오', () => {
  it('normal: token → done → final 순서로 보내고, final에 clientId를 echo한다', async () => {
    const { events, turn } = await runScenario('normal')
    expect(types(events)).toEqual(['token', 'done', 'final'])
    const final = events.at(-1)
    expect(final?.type === 'final' && final.userMessage.clientId).toBe('c-1')
    expect(turn.status).toBe('completed')
  })

  it('normal: final의 응답 텍스트는 token을 이어 붙인 것과 같다', async () => {
    const { events } = await runScenario('normal')
    const streamed = events.flatMap((e) => (e.type === 'token' ? [e.text] : [])).join('')
    const final = events.at(-1)
    expect(final?.type === 'final' && final.assistantMessage.text).toBe(streamed)
  })

  it('done-only: final 없이 done 뒤에 닫지만 서버에는 완료로 저장한다', async () => {
    const { events, ended, turn } = await runScenario('done-only')
    expect(types(events)).toEqual(['token', 'done'])
    expect(ended).toBe(true)
    expect(turn.status).toBe('completed')
  })

  it('close-after-final: final 직후 서버가 연결을 닫는다', async () => {
    const ctx = setup()
    const { json } = await createTurn(ctx.app, {
      clientId: 'c-1',
      text: 'hi',
      scenario: 'close-after-final',
    })
    const res = await ctx.app.request(`/turns/${json?.turnId}/stream?token=${json?.streamToken}`)
    // final에서 멈추지 않고 끝까지 읽어 본문이 닫히는지 확인한다.
    const text = await res.text()
    expect(text.trimEnd().endsWith('}')).toBe(true)
    expect(text).toContain('"type":"final"')
  })

  it('drop-after-saved: 저장한 뒤 done/final 없이 연결을 끊는다', async () => {
    const { events, turn, drops, turnId } = await runScenario('drop-after-saved')
    expect(types(events)).toEqual(['token'])
    expect(turn.status).toBe('completed')
    expect(drops).toEqual([turnId])
  })

  it('같은 seed는 같은 토큰을 만든다', async () => {
    const a = await runScenario('normal', 42)
    const b = await runScenario('normal', 42)
    const c = await runScenario('normal', 43)
    const texts = (r: { events: StreamEvent[] }) =>
      r.events.flatMap((e) => (e.type === 'token' ? [e.text] : []))
    expect(texts(a)).toEqual(texts(b))
    expect(texts(a)).not.toEqual(texts(c))
  })
})

describe('같은 clientId로 다시 보내기', () => {
  it('완료된 턴이면 새 턴을 만들지 않고, 구독하면 final만 다시 보낸다', async () => {
    const { app } = setup()
    const first = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    await readEvents(
      await app.request(`/turns/${first.json?.turnId}/stream?token=${first.json?.streamToken}`),
    )
    const second = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    expect(second.json?.turnId).toBe(first.json?.turnId)
    const { events } = await readEvents(
      await app.request(`/turns/${second.json?.turnId}/stream?token=${second.json?.streamToken}`),
    )
    expect(types(events)).toEqual(['final'])
    const page = messagesPageSchema.parse(
      await (await app.request('/messages', { headers: auth })).json(),
    )
    expect(page.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('진행 중인 턴이면 409', async () => {
    const { app } = setup()
    await createTurn(app, { clientId: 'c-1', text: 'hi' })
    const { res } = await createTurn(app, { clientId: 'c-1', text: 'hi' })
    expect(res.status).toBe(409)
  })
})

describe('GET /messages', () => {
  it('최신 페이지부터 주고, 커서로 더 오래된 페이지를 준다', async () => {
    const { app } = setup({ seedMessageCount: 25 })
    const get = async (query: string) =>
      messagesPageSchema.parse(
        await (await app.request(`/messages${query}`, { headers: auth })).json(),
      )
    const first = await get('?limit=10')
    expect(first.messages).toHaveLength(10)
    expect(first.nextCursor).not.toBeNull()
    const second = await get(`?limit=10&cursor=${first.nextCursor}`)
    const third = await get(`?limit=10&cursor=${second.nextCursor}`)
    expect(third.messages).toHaveLength(5)
    expect(third.nextCursor).toBeNull()
    const ids = [...third.messages, ...second.messages, ...first.messages].map((m) => m.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(25)
  })
})
