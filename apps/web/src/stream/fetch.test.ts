import type { StreamEvent } from '@stream-chat-lab/chat-protocol'
import { describe, expect, it, vi } from 'vitest'
import { createFetchTransport } from './fetch'
import type { StreamErrorInfo, StreamHandlers } from './transport'

const encoder = new TextEncoder()
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const token = (seq: number, text: string): StreamEvent => ({
  type: 'token',
  turnId: 't1',
  seq,
  text,
})
const frame = (id: number, event: StreamEvent) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`

/** 테스트에서 직접 청크를 밀어 넣는 응답 본문 */
function controllableBody() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
  })
  return {
    body,
    push: (chunk: string | Uint8Array) =>
      controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk),
    end: () => controller.close(),
  }
}

function setup(response: () => Promise<Response>) {
  const timers = new Map<number, () => void>()
  let nextTimer = 1
  const fetchImpl = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(() => response())
  const transport = createFetchTransport({
    baseUrl: 'http://api.test',
    token: 'demo-token',
    idleTimeoutMs: 1000,
    fetchImpl,
    setTimer: (fn) => {
      const id = nextTimer++
      timers.set(id, fn)
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
  })
  const events: [StreamEvent, string][] = []
  const errors: StreamErrorInfo[] = []
  const invalid: string[] = []
  const handlers: StreamHandlers = {
    onEvent: (e, id) => events.push([e, id]),
    onInvalid: (data) => invalid.push(data),
    onError: (info) => errors.push(info),
  }
  /** 대기 중인 idle 타이머를 모두 만료시킨다 */
  const expireTimers = () => {
    const pending = [...timers.values()]
    timers.clear()
    pending.forEach((fn) => fn())
  }
  return { transport, fetchImpl, handlers, events, errors, invalid, expireTimers, timers }
}

describe('createFetchTransport', () => {
  it('헤더로 인증하고, 이어 받을 때는 Last-Event-ID를 보낸다 (URL에 토큰을 넣지 않는다)', async () => {
    const t = setup(() => Promise.resolve(new Response(controllableBody().body)))
    t.transport.open({ turnId: 't1', streamToken: 'one-time', lastEventId: '5' }, t.handlers)
    await flush()
    const [url, init] = t.fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('http://api.test/turns/t1/stream')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer demo-token')
    expect(new Headers(init?.headers).get('Last-Event-ID')).toBe('5')
  })

  it('청크가 이벤트·한글 바이트 중간에서 잘려도 이벤트와 id를 그대로 전달한다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    const bytes = encoder.encode(frame(1, token(0, '안녕')) + frame(2, token(1, '하세요')))
    body.push(bytes.slice(0, 40))
    body.push(bytes.slice(40))
    await flush()
    expect(t.events).toEqual([
      [token(0, '안녕'), '1'],
      [token(1, '하세요'), '2'],
    ])
  })

  it('계약에 맞지 않는 data는 onInvalid로 전달한다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    body.push('data: {"type":"tool"}\n\n')
    await flush()
    expect(t.invalid).toEqual(['{"type":"tool"}'])
  })

  it('응답이 200이 아니면 상태 코드를 전달한다 (EventSource는 알 수 없는 값)', async () => {
    const t = setup(() => Promise.resolve(new Response('{}', { status: 401 })))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    expect(t.errors).toEqual([{ status: 401 }])
  })

  it('서버가 본문을 닫으면 closed로 알린다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    body.end()
    await flush()
    expect(t.errors).toEqual([{ reason: 'closed' }])
  })

  it('요청이 실패하면 network로 알린다', async () => {
    const t = setup(() => Promise.reject(new TypeError('Failed to fetch')))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    expect(t.errors).toEqual([{ reason: 'network' }])
  })

  it('close하면 요청을 abort하고 이후 콜백을 부르지 않는다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    const connection = t.transport.open(
      { turnId: 't1', streamToken: 'x', lastEventId: null },
      t.handlers,
    )
    await flush()
    connection.close()
    const signal = t.fetchImpl.mock.calls[0]?.[1].signal
    expect(signal?.aborted).toBe(true)
    await flush()
    expect(t.errors).toEqual([])
    expect(t.timers.size).toBe(0)
  })

  it('idleTimeoutMs 동안 아무 바이트도 오지 않으면 연결을 끊고 idle-timeout으로 알린다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    t.expireTimers()
    await flush()
    expect(t.errors).toEqual([{ reason: 'idle-timeout' }])
    expect(t.fetchImpl.mock.calls[0]?.[1].signal?.aborted).toBe(true)
  })

  it('주석 하트비트도 바이트이므로 idle 타이머를 다시 시작한다', async () => {
    const body = controllableBody()
    const t = setup(() => Promise.resolve(new Response(body.body)))
    t.transport.open({ turnId: 't1', streamToken: 'x', lastEventId: null }, t.handlers)
    await flush()
    const before = [...t.timers.keys()]
    body.push(': ping\n\n')
    await flush()
    // 이전 타이머는 취소되고 새 타이머가 걸린다.
    expect([...t.timers.keys()]).not.toEqual(before)
    expect(t.timers.size).toBe(1)
  })
})
