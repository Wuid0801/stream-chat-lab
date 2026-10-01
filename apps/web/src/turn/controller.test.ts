import {
  replyClientId,
  type CreateTurnResponse,
  type Message,
  type StreamEvent,
  type TurnResponse,
} from '@stream-chat-lab/chat-protocol'
import { describe, expect, it, vi } from 'vitest'
import type { ChatApi } from '../api/types'
import type {
  StreamErrorInfo,
  StreamHandlers,
  StreamTarget,
  StreamTransport,
} from '../stream/transport'
import { createTurnController, type TurnCallbacks } from './controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const message = (clientId: string, role: Message['role'], text: string): Message => ({
  id: `${role}-${clientId}`,
  clientId,
  role,
  text,
  createdAt: '2026-01-01T00:00:00.000Z',
})

function setup() {
  const creates: ReturnType<typeof deferred<CreateTurnResponse>>[] = []
  const turnLookups: ReturnType<typeof deferred<TurnResponse>>[] = []
  const renewals: ReturnType<typeof deferred<string>>[] = []
  const api: ChatApi = {
    createTurn: vi.fn(() => {
      const d = deferred<CreateTurnResponse>()
      creates.push(d)
      return d.promise
    }),
    getTurn: vi.fn(() => {
      const d = deferred<TurnResponse>()
      turnLookups.push(d)
      return d.promise
    }),
    renewStreamToken: vi.fn(() => {
      const d = deferred<string>()
      renewals.push(d)
      return d.promise
    }),
    getMessages: vi.fn(),
  }

  const connections: { target: StreamTarget; handlers: StreamHandlers; closed: boolean }[] = []
  const transport: StreamTransport = {
    open(target, handlers) {
      const conn = { target, handlers, closed: false }
      connections.push(conn)
      return {
        close: () => {
          conn.closed = true
        },
      }
    },
  }

  const callbacks = {
    onToken: vi.fn<TurnCallbacks['onToken']>(),
    onCompleted: vi.fn<TurnCallbacks['onCompleted']>(),
    onFailed: vi.fn<TurnCallbacks['onFailed']>(),
  }
  const warn = vi.fn<(message: string) => void>()
  const sleeps: number[] = []
  const controller = createTurnController({
    api,
    transport,
    callbacks,
    warn,
    // 이어 받기 대기 시간은 기록만 하고 바로 넘어간다.
    sleep: (ms) => {
      sleeps.push(ms)
      return Promise.resolve()
    },
  })

  /** n번째 준비 요청을 성공시키고 스트림이 열릴 때까지 기다린다 */
  async function connect(index: number, turnId = `t${index}`) {
    creates[index]?.resolve({ turnId, streamToken: `token-${index}` })
    await flush()
  }

  const conn = (i: number) => {
    const c = connections[i]
    if (!c) throw new Error(`연결 ${i} 없음`)
    return c
  }
  let eventId = 0
  const emit = (i: number, event: StreamEvent, id = String(++eventId)) =>
    conn(i).handlers.onEvent(event, id)
  const fail = (i: number, info: StreamErrorInfo = {}) => conn(i).handlers.onError(info)

  /** 이어 받기용 토큰 재발급을 모두(3번) 실패시킨다 */
  async function exhaustResume() {
    for (let i = 0; i < 3; i++) {
      await flush()
      renewals[renewals.length - 1]?.reject(new Error('network'))
    }
    await flush()
  }

  const finalEvent = (turnId: string, clientId: string): StreamEvent => ({
    type: 'final',
    turnId,
    userMessage: message(clientId, 'user', '질문'),
    assistantMessage: message(replyClientId(clientId), 'assistant', '답'),
  })

  return {
    api,
    controller,
    callbacks,
    warn,
    sleeps,
    creates,
    turnLookups,
    renewals,
    connections,
    connect,
    conn,
    emit,
    fail,
    exhaustResume,
    finalEvent,
  }
}

describe('예약', () => {
  it('준비 중에 두 번째 send를 거부한다', () => {
    const t = setup()
    expect(t.controller.send('a', 'c1').ok).toBe(true)
    expect(t.controller.send('b', 'c2')).toEqual({ ok: false, reason: 'busy' })
    expect(t.api.createTurn).toHaveBeenCalledTimes(1)
  })

  it('스트리밍 중에도 두 번째 send를 거부한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    expect(t.controller.send('b', 'c2').ok).toBe(false)
  })

  it('준비 요청이 실패해도 예약을 풀어 다음 send가 동작한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    t.creates[0]?.reject(new Error('network'))
    await flush()
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'create-failed')
    expect(t.controller.send('b', 'c2').ok).toBe(true)
  })

  it('final을 받으면 연결을 닫고 예약을 푼다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, t.finalEvent('t0', 'c1'))
    expect(t.conn(0).closed).toBe(true)
    expect(t.callbacks.onCompleted).toHaveBeenCalledTimes(1)
    expect(t.controller.send('b', 'c2').ok).toBe(true)
  })
})

describe('취소', () => {
  it('준비 중에 취소하면 준비가 끝나도 연결을 만들지 않는다', async () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    if (!result.ok) throw new Error('send 실패')
    result.turn.abort()
    await t.connect(0)
    expect(t.connections).toHaveLength(0)
    expect(result.turn.status).toBe('aborted')
  })

  it('준비 중에 취소하면 바로 다음 send를 받는다', () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    if (result.ok) result.turn.abort()
    expect(t.controller.send('b', 'c2').ok).toBe(true)
  })

  it('취소하면 준비 요청에 abort 신호를 보낸다', () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    if (result.ok) result.turn.abort()
    const signal = vi.mocked(t.api.createTurn).mock.calls[0]?.[1]
    expect(signal?.aborted).toBe(true)
  })

  it('dispose하면 연결을 닫고 콜백을 부르지 않는다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.controller.dispose()
    expect(t.conn(0).closed).toBe(true)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: 'x' })
    expect(t.callbacks.onToken).not.toHaveBeenCalled()
    expect(t.callbacks.onFailed).not.toHaveBeenCalled()
  })
})

describe('이전 턴 격리', () => {
  it('취소된 턴의 연결에 남아 있던 이벤트는 새 턴에 영향을 주지 않는다', async () => {
    const t = setup()
    const first = t.controller.send('a', 'c1')
    await t.connect(0)
    if (first.ok) first.turn.abort()
    t.controller.send('b', 'c2')
    await t.connect(1)

    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '늦은 토큰' })
    t.emit(0, t.finalEvent('t0', 'c1'))
    t.fail(0)

    expect(t.callbacks.onToken).not.toHaveBeenCalled()
    expect(t.callbacks.onCompleted).not.toHaveBeenCalled()
    expect(t.api.getTurn).not.toHaveBeenCalled()
    expect(t.controller.send('c', 'c3').ok).toBe(false) // 두 번째 턴은 여전히 진행 중
  })

  it('final 뒤의 연결 오류는 무시한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, t.finalEvent('t0', 'c1'))
    t.fail(0)
    expect(t.callbacks.onFailed).not.toHaveBeenCalled()
    expect(t.api.getTurn).not.toHaveBeenCalled()
  })

  it('final 뒤의 error 이벤트는 무시한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, t.finalEvent('t0', 'c1'))
    t.emit(0, { type: 'error', turnId: 't0', code: 'late', message: '늦은 오류' })
    expect(t.callbacks.onFailed).not.toHaveBeenCalled()
  })
})

describe('스트림 이벤트', () => {
  it('토큰을 clientId와 함께 전달한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '안' })
    t.emit(0, { type: 'token', turnId: 't0', seq: 1, text: '녕' })
    expect(t.callbacks.onToken.mock.calls).toEqual([
      ['c1', '안'],
      ['c1', '녕'],
    ])
  })

  it('done은 종료가 아니다. 이후 final까지 기다린다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'done', turnId: 't0' })
    expect(t.conn(0).closed).toBe(false)
    expect(t.controller.send('b', 'c2').ok).toBe(false)
  })

  it('서버가 보낸 error 이벤트는 실패로 끝낸다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'error', turnId: 't0', code: 'overloaded', message: '바쁨' })
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'overloaded')
    expect(t.conn(0).closed).toBe(true)
  })
})

describe('끊김과 오탐 복구', () => {
  const completedTurn = (clientId: string): TurnResponse => ({
    id: 't0',
    clientId,
    status: 'completed',
    userMessage: message(clientId, 'user', '질문'),
    assistantMessage: message(replyClientId(clientId), 'assistant', '답'),
  })

  it('토큰 없이 끊기면 이어 받기나 서버 확인 없이 실패로 끝낸다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.fail(0)
    expect(t.conn(0).closed).toBe(true)
    expect(t.api.renewStreamToken).not.toHaveBeenCalled()
    expect(t.api.getTurn).not.toHaveBeenCalled()
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'stream-failed')
  })

  it('401이면 unauthorized로 실패한다 (fetch 어댑터만 상태 코드를 안다)', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.fail(0, { status: 401 })
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'unauthorized')
  })

  it('5xx면 server-error로 실패한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.fail(0, { status: 503 })
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'server-error')
  })

  it('이어 받기에 모두 실패하면 서버 상태를 확인해, 완료돼 있으면 성공으로 복구한다', async () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    // 연결은 즉시 닫는다. 자동 재연결 = 같은 1회용 토큰 재사용을 막는다.
    expect(t.conn(0).closed).toBe(true)
    await t.exhaustResume()
    expect(t.api.renewStreamToken).toHaveBeenCalledTimes(3)
    expect(result.ok && result.turn.status).toBe('reconciling')
    expect(t.api.getTurn).toHaveBeenCalledWith('t0')

    t.turnLookups[0]?.resolve(completedTurn('c1'))
    await flush()
    expect(t.callbacks.onCompleted).toHaveBeenCalledTimes(1)
    expect(t.callbacks.onFailed).not.toHaveBeenCalled()
    expect(result.ok && result.turn.status).toBe('completed')
  })

  it('이어 받기에 모두 실패하고 서버에 완료돼 있지 않으면 실패로 끝낸다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    await t.exhaustResume()
    t.turnLookups[0]?.resolve({
      ...completedTurn('c1'),
      status: 'streaming',
      assistantMessage: null,
    })
    await flush()
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'stream-dropped')
  })

  it('서버 상태 확인이 끝날 때까지 다음 send를 거부한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    await t.exhaustResume()
    expect(t.controller.send('b', 'c2').ok).toBe(false)
    t.turnLookups[0]?.reject(new Error('network'))
    await flush()
    expect(t.callbacks.onFailed).toHaveBeenCalledWith('c1', 'reconcile-failed')
    expect(t.controller.send('b', 'c2').ok).toBe(true)
  })

  it('done 뒤에 끊기면 이어 받지 않고, 계약 위반을 경고한 뒤 서버 상태로 복구한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.emit(0, { type: 'done', turnId: 't0' })
    t.fail(0)
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('계약 위반'))
    expect(t.api.renewStreamToken).not.toHaveBeenCalled()
    t.turnLookups[0]?.resolve(completedTurn('c1'))
    await flush()
    expect(t.callbacks.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('서버 상태 확인 중에 dispose하면 늦게 온 결과를 무시한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    await t.exhaustResume()
    t.controller.dispose()
    t.turnLookups[0]?.resolve(completedTurn('c1'))
    await flush()
    expect(t.callbacks.onCompleted).not.toHaveBeenCalled()
  })

  it('계약에 맞지 않는 data는 경고하고 무시한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.conn(0).handlers.onInvalid('{"type":"tool"}', 'unknown type')
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('계약 위반'))
    expect(t.callbacks.onFailed).not.toHaveBeenCalled()
  })
})

describe('이어 받기', () => {
  it('토큰을 받은 뒤 끊기면 새 토큰으로 마지막 이벤트 id부터 다시 구독한다 (턴을 다시 만들지 않는다)', async () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '안' }, '1')
    t.emit(0, { type: 'token', turnId: 't0', seq: 1, text: '녕' }, '2')
    t.fail(0)
    expect(result.ok && result.turn.status).toBe('resuming')
    await flush()
    t.renewals[0]?.resolve('renewed')
    await flush()

    expect(t.api.createTurn).toHaveBeenCalledTimes(1)
    expect(t.conn(1).target).toEqual({ turnId: 't0', streamToken: 'renewed', lastEventId: '2' })
    expect(result.ok && result.turn.status).toBe('streaming')
  })

  it('이어 받은 연결로 끝까지 받으면 완료된다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    await flush()
    t.renewals[0]?.resolve('renewed')
    await flush()
    t.emit(1, { type: 'done', turnId: 't0' })
    t.emit(1, t.finalEvent('t0', 'c1'))
    expect(t.callbacks.onCompleted).toHaveBeenCalledTimes(1)
    expect(t.warn).not.toHaveBeenCalled()
  })

  it('대기 시간을 0.5초 → 1초 → 2초로 늘린다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    await t.exhaustResume()
    expect(t.sleeps).toEqual([500, 1000, 2000])
  })

  it('이벤트를 받으면 이어 받기 횟수를 다시 센다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: 'a' })
    t.fail(0)
    await flush()
    t.renewals[0]?.resolve('r1')
    await flush()
    t.emit(1, { type: 'token', turnId: 't0', seq: 1, text: 'b' })
    t.fail(1)
    await flush()
    expect(t.sleeps).toEqual([500, 500])
  })

  it('이미 받은 seq의 토큰은 다시 전달하지 않는다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '안' })
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '안' })
    t.emit(0, { type: 'token', turnId: 't0', seq: 1, text: '녕' })
    expect(t.callbacks.onToken.mock.calls).toEqual([
      ['c1', '안'],
      ['c1', '녕'],
    ])
  })

  it('스트림으로 받은 텍스트와 final의 텍스트가 다르면 계약 위반을 경고한다', async () => {
    const t = setup()
    t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '다른 답' })
    t.emit(0, t.finalEvent('t0', 'c1'))
    expect(t.warn).toHaveBeenCalledWith(expect.stringContaining('계약 위반'))
    expect(t.callbacks.onCompleted).toHaveBeenCalledTimes(1)
  })

  it('이어 받기를 기다리는 중에 취소하면 다시 구독하지 않는다', async () => {
    const t = setup()
    const result = t.controller.send('a', 'c1')
    await t.connect(0)
    t.emit(0, { type: 'token', turnId: 't0', seq: 0, text: '답' })
    t.fail(0)
    if (result.ok) result.turn.abort()
    await flush()
    t.renewals[0]?.resolve('late')
    await flush()
    expect(t.connections).toHaveLength(1)
  })
})
