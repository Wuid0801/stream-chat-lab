import type { ScenarioOptions, StreamEvent } from '@stream-chat-lab/chat-protocol'
import type { SSEStreamingApi } from 'hono/streaming'
import { seededRandom } from './random'
import { generateReply } from './reply'
import type { TurnRecord } from './store'

/**
 * 응답 생성과 연결을 분리한다. (docs/decisions/011)
 *
 * - 생성기: 턴마다 한 번 돈다. 이벤트를 버퍼에 쌓고, 연결이 끊겨도 끝까지 돌아 저장한다.
 * - 구독자: 연결마다 하나. 버퍼에서 lastEventId 다음 이벤트부터 보내고, 새 이벤트를 기다린다.
 *   연결 단위의 장애(끊기, 바이트 분할, 몰아 보내기)는 구독자가 주입한다.
 */
interface TurnRuntime {
  /** id = 인덱스 + 1 */
  events: StreamEvent[]
  /** 생성이 끝났다 (더 이상 이벤트가 추가되지 않는다) */
  ended: boolean
  listeners: Set<() => void>
  /** 응답 토큰 수 (drop-mid-stream이 끊을 위치를 정할 때 쓴다) */
  tokenCount: number
}

export interface RuntimeDeps {
  sleep: (ms: number) => Promise<void>
  now: () => number
  completeTurn: (turn: TurnRecord, text: string) => void
  heartbeatMs: number
  lingerMs: number
}

const encoder = new TextEncoder()

export function createTurnRuntime(deps: RuntimeDeps) {
  const runtimes = new Map<string, TurnRuntime>()

  function push(runtime: TurnRuntime, event: StreamEvent) {
    runtime.events.push(event)
    for (const listener of [...runtime.listeners]) listener()
  }

  /** 생성기를 시작한다. 이미 시작했으면 아무것도 하지 않는다. */
  function ensureStarted(turn: TurnRecord): TurnRuntime {
    const existing = runtimes.get(turn.id)
    if (existing) return existing
    const reply = generateReply(turn.seed, turn.replyOptions)
    const runtime: TurnRuntime = {
      events: [],
      ended: false,
      listeners: new Set(),
      tokenCount: reply.tokens.length,
    }
    runtimes.set(turn.id, runtime)

    void (async () => {
      const options = turn.scenarioOptions
      if (turn.scenario === 'slow-first-token') {
        const delay =
          options.firstTokenDelayMs ?? Math.round(5000 + seededRandom(turn.seed + 1)() * 10_000)
        await deps.sleep(delay)
      }
      const silenceAt = Math.floor(reply.tokens.length / 2)
      for (const [seq, text] of reply.tokens.entries()) {
        if (turn.scenario === 'long-silence' && seq === silenceAt) {
          await deps.sleep(options.silenceMs ?? 60_000)
        }
        push(runtime, { type: 'token', turnId: turn.id, seq, text })
        await deps.sleep(reply.intervalMs)
      }
      deps.completeTurn(turn, reply.tokens.join(''))
      push(runtime, { type: 'done', turnId: turn.id })
      if (turn.scenario !== 'done-only' && turn.assistantMessage) {
        push(runtime, {
          type: 'final',
          turnId: turn.id,
          userMessage: turn.userMessage,
          assistantMessage: turn.assistantMessage,
        })
      }
      runtime.ended = true
      for (const listener of [...runtime.listeners]) listener()
    })()

    return runtime
  }

  /** 새 이벤트가 오거나 timeoutMs가 지나면 끝난다. timeoutMs가 null이면 이벤트만 기다린다. */
  function waitForChange(
    runtime: TurnRuntime,
    timeoutMs: number | null,
  ): Promise<'event' | 'timeout'> {
    return new Promise((resolve) => {
      const listener = () => {
        runtime.listeners.delete(listener)
        resolve('event')
      }
      runtime.listeners.add(listener)
      if (timeoutMs !== null) {
        void deps.sleep(timeoutMs).then(() => {
          if (runtime.listeners.delete(listener)) resolve('timeout')
        })
      }
    })
  }

  async function subscribe(
    stream: SSEStreamingApi,
    turn: TurnRecord,
    afterId: number,
    hooks: { firstSubscription: boolean; drop: () => void },
  ): Promise<void> {
    const runtime = ensureStarted(turn)
    const options = turn.scenarioOptions
    const heartbeatMs = options.heartbeatMs ?? deps.heartbeatMs
    const heartbeat = options.heartbeat ?? true
    const writer = createWriter(stream, turn, options, deps)
    const first = hooks.firstSubscription
    // 첫 연결만 토큰의 1/3 지점에서 끊는다. 이어 받은 연결은 끝까지 받는다.
    const dropAfterSeq =
      first && turn.scenario === 'drop-mid-stream' ? Math.floor(runtime.tokenCount / 3) : null

    let next = Math.max(0, afterId)
    while (!stream.aborted) {
      while (next < runtime.events.length) {
        const event = runtime.events[next] as StreamEvent
        if (first && turn.scenario === 'drop-after-saved' && event.type === 'done') {
          // 서버 저장은 끝났지만 done/final을 보내기 직전에 TCP 연결이 끊긴다.
          await writer.flush()
          hooks.drop()
          return
        }
        await writer.event(next + 1, event)
        next++
        if (dropAfterSeq !== null && event.type === 'token' && event.seq === dropAfterSeq) {
          await writer.flush()
          hooks.drop()
          return
        }
        if (event.type === 'final' && turn.scenario === 'close-after-final') {
          await writer.flush()
          return
        }
      }
      if (runtime.ended) break
      const result = await waitForChange(runtime, heartbeat ? heartbeatMs : null)
      if (result === 'timeout' && !stream.aborted) await writer.comment('ping')
    }
    await writer.flush()
    if (stream.aborted || turn.scenario === 'done-only') return

    // final 뒤에는 클라이언트가 먼저 닫는 것이 정상이다. 그동안 하트비트를 보낸다.
    for (let waited = 0; waited < deps.lingerMs && !stream.aborted; waited += heartbeatMs) {
      await deps.sleep(heartbeatMs)
      if (!stream.aborted && heartbeat) await writer.comment('ping')
    }
  }

  return { subscribe, ensureStarted }
}

interface Writer {
  event(id: number, event: StreamEvent): Promise<void>
  comment(text: string): Promise<void>
  flush(): Promise<void>
}

/** 연결 단위의 전송 방식. 시나리오에 따라 그대로, 바이트 분할, 몰아 보내기 중 하나다. */
function createWriter(
  stream: SSEStreamingApi,
  turn: TurnRecord,
  options: ScenarioOptions,
  deps: RuntimeDeps,
): Writer {
  if (turn.scenario === 'chunk-chaos') {
    const random = seededRandom(turn.seed + 2)
    const endings = ['\n', '\r\n', '\r'] as const
    let previous = ''
    const eol = () => {
      // \r 바로 뒤에 \n으로 시작하는 줄바꿈이 오면 둘이 합쳐져 \r\n 하나로 읽힌다(빈 줄이 사라진다).
      // 보내는 쪽이 만들면 안 되는 모호한 순서라서 피한다.
      const choices = previous === '\r' ? (['\r\n', '\r'] as const) : endings
      previous = choices[Math.floor(random() * choices.length)] as string
      return previous
    }
    // 직렬화한 이벤트를 1~7바이트 조각으로 잘라 보낸다. 줄바꿈은 줄마다 무작위로 고른다.
    async function writeChaos(text: string) {
      const bytes = encoder.encode(text)
      for (let i = 0; i < bytes.length;) {
        const size = 1 + Math.floor(random() * 7)
        await stream.write(bytes.slice(i, i + size))
        i += size
      }
    }
    return {
      event: (id, event) =>
        writeChaos(
          `: 청크 경계 시험${eol()}id: ${id}${eol()}data: ${JSON.stringify(event)}${eol()}${eol()}`,
        ),
      comment: (text) => writeChaos(`: ${text}${eol()}${eol()}`),
      flush: () => Promise.resolve(),
    }
  }

  if (turn.scenario === 'proxy-buffering') {
    // 중간 프록시가 응답을 모아 두었다가 bufferMs마다 한 번에 내보내는 상황을 흉내 낸다.
    const bufferMs = options.bufferMs ?? 2000
    let buffer = ''
    let lastFlush = deps.now()
    async function flush() {
      if (buffer === '') return
      const text = buffer
      buffer = ''
      lastFlush = deps.now()
      await stream.write(text)
    }
    async function append(text: string) {
      buffer += text
      if (deps.now() - lastFlush >= bufferMs) await flush()
    }
    return {
      event: (id, event) => append(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`),
      comment: (text) => append(`: ${text}\n\n`),
      flush,
    }
  }

  return {
    event: (id, event) => stream.writeSSE({ id: String(id), data: JSON.stringify(event) }),
    comment: async (text) => {
      await stream.write(`: ${text}\n\n`)
    },
    flush: () => Promise.resolve(),
  }
}
