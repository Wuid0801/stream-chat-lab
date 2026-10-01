import {
  messagesPageSchema,
  streamTokenResponseSchema,
  turnResponseSchema,
  type CreateTurnRequest,
} from '@stream-chat-lab/chat-protocol'
import { describe, expect, it } from 'vitest'
import { auth, createTurn, readEvents, setup, tokenTexts, types, type App } from './test-helpers'

const SEED = 7

async function start(app: App, body: Partial<CreateTurnRequest> = {}) {
  const { res, json } = await createTurn(app, {
    clientId: 'c-1',
    text: '안녕',
    seed: SEED,
    ...body,
  })
  if (!json) throw new Error(`턴 생성 실패: ${res.status}`)
  return json
}

const stream = (app: App, turnId: string, token: string, lastEventId?: string) =>
  app.request(
    `/turns/${turnId}/stream?token=${token}${lastEventId ? `&lastEventId=${lastEventId}` : ''}`,
  )

async function renew(app: App, turnId: string): Promise<string> {
  const res = await app.request(`/turns/${turnId}/stream-token`, { method: 'POST', headers: auth })
  return streamTokenResponseSchema.parse(await res.json()).streamToken
}

async function getTurn(app: App, turnId: string) {
  return turnResponseSchema.parse(
    await (await app.request(`/turns/${turnId}`, { headers: auth })).json(),
  )
}

/** 생성이 연결과 따로 돌므로, 끝날 때까지 이벤트 루프를 몇 번 돌려 준다. */
async function waitCompleted(app: App, turnId: string) {
  for (let i = 0; i < 100; i++) {
    if ((await getTurn(app, turnId)).status === 'completed') return
    await new Promise((r) => setTimeout(r, 0))
  }
  throw new Error('완료되지 않았다')
}

/** 같은 seed의 normal 응답 (비교 기준) */
async function normalTokens(): Promise<string[]> {
  const { app } = setup()
  const turn = await start(app)
  return tokenTexts((await readEvents(await stream(app, turn.turnId, turn.streamToken))).events)
}

describe('이벤트 id와 버퍼', () => {
  it('이벤트마다 1부터 이어지는 id를 붙인다', async () => {
    const { app } = setup()
    const turn = await start(app)
    const { ids } = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(ids).toEqual(ids.map((_, i) => String(i + 1)))
  })

  it('구독자가 끊어도 생성은 계속되어 저장된다', async () => {
    const { app } = setup()
    const turn = await start(app)
    await readEvents(await stream(app, turn.turnId, turn.streamToken), { stopAfter: 2 })
    await waitCompleted(app, turn.turnId)
  })

  it('lastEventId로 다시 구독하면 그다음 이벤트부터 받는다 (중복·누락 없음)', async () => {
    const { app } = setup()
    const turn = await start(app)
    const first = await readEvents(await stream(app, turn.turnId, turn.streamToken), {
      stopAfter: 5,
    })
    const second = await readEvents(
      await stream(app, turn.turnId, await renew(app, turn.turnId), first.ids.at(-1)),
    )
    expect(second.ids[0]).toBe('6')
    const final = second.events.at(-1)
    const all = [...tokenTexts(first.events), ...tokenTexts(second.events)].join('')
    expect(final?.type === 'final' && final.assistantMessage.text).toBe(all)
  })

  it('Last-Event-ID 헤더로도 이어 받는다 (fetch 어댑터)', async () => {
    const { app } = setup()
    const turn = await start(app)
    await readEvents(await stream(app, turn.turnId, turn.streamToken), { stopAfter: 3 })
    const res = await app.request(`/turns/${turn.turnId}/stream`, {
      headers: { ...auth, 'Last-Event-ID': '3' },
    })
    expect((await readEvents(res)).ids[0]).toBe('4')
  })
})

describe('POST /turns/:id/stream-token', () => {
  it('인증이 없으면 401', async () => {
    const { app } = setup()
    const turn = await start(app)
    const res = await app.request(`/turns/${turn.turnId}/stream-token`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('없는 턴이면 404', async () => {
    const { app } = setup()
    const res = await app.request('/turns/nope/stream-token', { method: 'POST', headers: auth })
    expect(res.status).toBe(404)
  })
})

describe('끊김 시나리오', () => {
  it('drop-mid-stream: 첫 연결은 토큰 중간에 끊기고, 이어 받으면 나머지를 받는다', async () => {
    const { app, drops } = setup()
    const turn = await start(app, { scenario: 'drop-mid-stream' })
    const first = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(types(first.events)).toEqual(['token'])
    expect(drops).toEqual([turn.turnId])

    const second = await readEvents(
      await stream(app, turn.turnId, await renew(app, turn.turnId), first.ids.at(-1)),
    )
    expect(types(second.events)).toEqual(['token', 'done', 'final'])
    expect([...tokenTexts(first.events), ...tokenTexts(second.events)]).toEqual(
      await normalTokens(),
    )
  })

  it('drop-after-saved: 저장 뒤 done 전에 끊기고, 이어 받으면 done과 final을 받는다', async () => {
    const { app } = setup()
    const turn = await start(app, { scenario: 'drop-after-saved' })
    const first = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(types(first.events)).toEqual(['token'])
    const second = await readEvents(
      await stream(app, turn.turnId, await renew(app, turn.turnId), first.ids.at(-1)),
    )
    expect(second.events.map((e) => e.type)).toEqual(['done', 'final'])
  })
})

describe('HTTP 오류 시나리오', () => {
  for (const [scenario, status] of [
    ['http-401', 401],
    ['http-5xx', 503],
  ] as const) {
    it(`${scenario}: 첫 구독은 ${status}, 턴은 failed. 같은 clientId로 다시 보내면 같은 턴으로 성공한다`, async () => {
      const { app } = setup()
      const turn = await start(app, { scenario })
      expect((await stream(app, turn.turnId, turn.streamToken)).status).toBe(status)
      expect((await getTurn(app, turn.turnId)).status).toBe('failed')

      const retry = await start(app, { scenario })
      expect(retry.turnId).toBe(turn.turnId)
      const { events } = await readEvents(await stream(app, retry.turnId, retry.streamToken))
      expect(events.at(-1)?.type).toBe('final')

      const page = messagesPageSchema.parse(
        await (await app.request('/messages', { headers: auth })).json(),
      )
      expect(page.messages.filter((m) => m.role === 'user')).toHaveLength(1)
    })
  }
})

describe('전송 방식 시나리오', () => {
  it('chunk-chaos: 줄바꿈을 섞고 무작위로 잘라 보내도 내용은 normal과 같다', async () => {
    const { app } = setup()
    const turn = await start(app, { scenario: 'chunk-chaos' })
    const { events, raw } = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(raw).toContain('\r')
    expect(tokenTexts(events)).toEqual(await normalTokens())
    expect(events.at(-1)?.type).toBe('final')
  })

  it('proxy-buffering: 모아서 보내도 내용은 normal과 같다', async () => {
    const { app } = setup()
    const turn = await start(app, { scenario: 'proxy-buffering' })
    const { events } = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(tokenTexts(events)).toEqual(await normalTokens())
    expect(events.at(-1)?.type).toBe('final')
  })
})

describe('시간 시나리오', () => {
  // 시간을 1/1000로 줄인 실제 타이머. 하트비트(15초 → 15ms)가 침묵(60초 → 60ms) 동안 몇 번 돈다.
  const scaledSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms / 1000))

  it('long-silence: 하트비트를 켜면 침묵 중에 주석 하트비트를 보낸다', async () => {
    const { app } = setup({ sleep: scaledSleep })
    const turn = await start(app, { scenario: 'long-silence' })
    const { raw, events } = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(raw).toContain(': ping')
    expect(events.at(-1)?.type).toBe('final')
  })

  it('long-silence: 하트비트를 끄면 침묵 중에 아무것도 보내지 않는다', async () => {
    const { app } = setup({ sleep: scaledSleep })
    const turn = await start(app, {
      scenario: 'long-silence',
      scenarioOptions: { heartbeat: false },
    })
    const { raw, events } = await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(raw).not.toContain(': ping')
    expect(events.at(-1)?.type).toBe('final')
  })

  it('slow-first-token: 첫 토큰 전에 정해진 시간만큼 기다린다', async () => {
    const sleeps: number[] = []
    const { app } = setup({
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    const turn = await start(app, {
      scenario: 'slow-first-token',
      scenarioOptions: { firstTokenDelayMs: 9000 },
    })
    await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(sleeps[0]).toBe(9000)
  })

  it('slow-first-token: 값이 없으면 seed로 5~15초를 고른다', async () => {
    const sleeps: number[] = []
    const { app } = setup({
      sleep: (ms) => {
        sleeps.push(ms)
        return Promise.resolve()
      },
    })
    const turn = await start(app, { scenario: 'slow-first-token' })
    await readEvents(await stream(app, turn.turnId, turn.streamToken))
    expect(sleeps[0]).toBeGreaterThanOrEqual(5000)
    expect(sleeps[0]).toBeLessThanOrEqual(15000)
  })
})
