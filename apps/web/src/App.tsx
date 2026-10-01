import { scenarioSchema, type ScenarioOptions } from '@stream-chat-lab/chat-protocol'
import { createApiClient } from './api/client'
import { ChatView } from './chat/ChatView'
import { createEventSourceTransport } from './stream/eventsource'
import { createFetchTransport } from './stream/fetch'
import type { TurnRequestOptions } from './turn/controller'
import { parseVariant } from './variants/config'

const API_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'
// 데모용 고정 토큰. 목 서버의 DEMO_TOKEN과 같다.
const DEMO_TOKEN = 'demo-token'
/** fetch 어댑터의 idle 타임아웃 기본값: 서버 하트비트(15초) 세 번 */
const DEFAULT_IDLE_TIMEOUT_MS = 45_000

const api = createApiClient({ baseUrl: API_URL, token: DEMO_TOKEN })

function readInt(params: URLSearchParams, name: string): number | undefined {
  const value = Number(params.get(name))
  return params.has(name) && Number.isInteger(value) ? value : undefined
}

/**
 * URL로 시나리오, 전송 방식, 비교 버전을 고른다. (README "실행 방법")
 * - `scenario`, `seed`: 목 서버 장애 시나리오 (docs/protocol.md)
 * - `firstTokenDelay`, `silence`, `heartbeat=off`, `heartbeatMs`, `bufferMs`: 시나리오 시간 값
 * - `transport`: `eventsource`(기본) 또는 `fetch`. `idleTimeout`: fetch 어댑터의 idle 타임아웃
 * - `v`: 렌더 비교 버전 0~3 (기본 최신)
 * - `history`, `tokens`, `rate`: 측정 조건 (packages/bench)
 */
function readParams() {
  const params = new URLSearchParams(window.location.search)
  const scenario = scenarioSchema.safeParse(params.get('scenario'))
  const seed = readInt(params, 'seed')
  const replyTokens = readInt(params, 'tokens')
  const tokensPerSecond = readInt(params, 'rate')

  const timing: [keyof ScenarioOptions, number | undefined][] = [
    ['firstTokenDelayMs', readInt(params, 'firstTokenDelay')],
    ['silenceMs', readInt(params, 'silence')],
    ['heartbeatMs', readInt(params, 'heartbeatMs')],
    ['bufferMs', readInt(params, 'bufferMs')],
  ]
  const scenarioOptions: ScenarioOptions = Object.fromEntries(
    timing.filter(([, value]) => value !== undefined),
  )
  if (params.get('heartbeat') === 'off') scenarioOptions.heartbeat = false

  const turnRequest: TurnRequestOptions = {
    ...(scenario.success ? { scenario: scenario.data } : {}),
    ...(Object.keys(scenarioOptions).length ? { scenarioOptions } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(replyTokens === undefined ? {} : { replyTokens }),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  }

  const transportName = params.get('transport') === 'fetch' ? 'fetch' : 'eventsource'
  const transport =
    transportName === 'fetch'
      ? createFetchTransport({
          baseUrl: API_URL,
          token: DEMO_TOKEN,
          idleTimeoutMs: readInt(params, 'idleTimeout') ?? DEFAULT_IDLE_TIMEOUT_MS,
        })
      : createEventSourceTransport(API_URL)

  return {
    turnRequest,
    transportName,
    transport,
    variant: parseVariant(params.get('v')),
    historyLimit: readInt(params, 'history'),
  }
}

const { turnRequest, transportName, transport, variant, historyLimit } = readParams()

export function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>stream-chat-lab</h1>
        <span className="badge" data-testid="scenario">
          scenario: {turnRequest.scenario ?? 'normal'}
          {turnRequest.seed === undefined ? '' : ` · seed ${turnRequest.seed}`} · {transportName} ·
          v{variant.version}
        </span>
      </header>
      <ChatView
        api={api}
        transport={transport}
        variant={variant}
        turnRequest={turnRequest}
        {...(historyLimit === undefined ? {} : { historyLimit })}
      />
    </main>
  )
}
