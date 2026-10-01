import { turnResponseSchema } from '@stream-chat-lab/chat-protocol'
import { describe, expect, it } from 'vitest'
import { auth, createTurn, readEvents, setup, tokenTexts, type App } from './test-helpers'

const never = () => new Promise<void>(() => {})

/**
 * 토큰 간격(1초 미만) sleep은 처음 n번만 바로 끝나고, 그 뒤로는 끝나지 않는다. 생성기를 n+1번째 토큰 뒤에서 멈춰 둔다.
 * 하트비트 대기(15초)는 끝나지 않게 두어 구독자가 이벤트만 기다리게 한다.
 */
const pauseAfter = (n: number) => {
  let tokens = 0
  return (ms: number) => (ms >= 1000 || ++tokens > n ? never() : Promise.resolve())
}

const flush = () => new Promise((r) => setTimeout(r, 0))

async function cancel(app: App, turnId: string, headers: Record<string, string> = auth) {
  return app.request(`/turns/${turnId}/cancel`, { method: 'POST', headers })
}

async function start(app: App) {
  const { json } = await createTurn(app, { clientId: 'c-1', text: '긴 질문', seed: 7 })
  if (!json) throw new Error('턴 생성 실패')
  return json
}

describe('POST /turns/:id/cancel', () => {
  it('인증이 없으면 401, 없는 턴이면 404', async () => {
    const { app } = setup()
    const turn = await start(app)
    expect((await cancel(app, turn.turnId, {})).status).toBe(401)
    expect((await cancel(app, 'nope')).status).toBe(404)
  })

  it('생성 중에 중지하면 거기까지의 응답을 stopped로 저장하고 돌려준다', async () => {
    const { app } = setup({ sleep: pauseAfter(3) })
    const turn = await start(app)
    const res = await app.request(`/turns/${turn.turnId}/stream?token=${turn.streamToken}`)
    await flush()

    const cancelled = turnResponseSchema.parse(await (await cancel(app, turn.turnId)).json())
    expect(cancelled.status).toBe('completed')
    expect(cancelled.assistantMessage?.stopped).toBe(true)

    // 구독자는 중지 시점까지의 토큰과, 중지된 응답을 담은 final을 받는다.
    const { events } = await readEvents(res)
    expect(tokenTexts(events)).toHaveLength(4)
    const final = events.at(-1)
    expect(final?.type === 'final' && final.assistantMessage).toEqual(cancelled.assistantMessage)
    expect(cancelled.assistantMessage?.text).toBe(tokenTexts(events).join(''))
  })

  it('중지한 뒤에는 생성기가 깨어나도 토큰을 더 만들지 않는다', async () => {
    let wake!: () => void
    let tokens = 0
    const { app } = setup({
      sleep: (ms) => {
        if (ms >= 1000) return never()
        return ++tokens === 2 ? new Promise<void>((r) => (wake = r)) : Promise.resolve()
      },
    })
    const turn = await start(app)
    const res = await app.request(`/turns/${turn.turnId}/stream?token=${turn.streamToken}`)
    await flush()
    await cancel(app, turn.turnId)
    wake()
    await flush()
    const { events } = await readEvents(res)
    expect(events.filter((e) => e.type === 'final')).toHaveLength(1)
    expect(tokenTexts(events)).toHaveLength(2)
  })

  it('이미 완료된 턴은 그대로 돌려준다', async () => {
    const { app } = setup()
    const turn = await start(app)
    await readEvents(await app.request(`/turns/${turn.turnId}/stream?token=${turn.streamToken}`))
    const result = turnResponseSchema.parse(await (await cancel(app, turn.turnId)).json())
    expect(result.assistantMessage?.stopped).toBeUndefined()
  })

  it('구독 전에 중지하면 빈 응답을 stopped로 저장한다', async () => {
    const { app } = setup()
    const turn = await start(app)
    const result = turnResponseSchema.parse(await (await cancel(app, turn.turnId)).json())
    expect(result.status).toBe('completed')
    expect(result.assistantMessage).toMatchObject({ text: '', stopped: true })
  })
})
