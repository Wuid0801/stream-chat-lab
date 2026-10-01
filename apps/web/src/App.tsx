import { scenarioSchema } from '@stream-chat-lab/chat-protocol'
import { createApiClient } from './api/client'
import { ChatView } from './chat/ChatView'
import { eventSourceTransport } from './stream/eventsource'
import type { TurnRequestOptions } from './turn/controller'
import { parseVariant } from './variants/config'

const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8787',
  // 데모용 고정 토큰. 목 서버의 DEMO_TOKEN과 같다.
  token: 'demo-token',
})

function readInt(params: URLSearchParams, name: string): number | undefined {
  const value = Number(params.get(name))
  return params.has(name) && Number.isInteger(value) ? value : undefined
}

/**
 * URL로 시나리오와 비교 버전을 고른다.
 * - `scenario`, `seed`: 목 서버 장애 시나리오 (docs/protocol.md)
 * - `v`: 렌더 비교 버전 0~3 (기본 최신)
 * - `history`, `tokens`, `rate`: 측정 조건 (packages/bench)
 */
function readParams() {
  const params = new URLSearchParams(window.location.search)
  const scenario = scenarioSchema.safeParse(params.get('scenario'))
  const seed = readInt(params, 'seed')
  const replyTokens = readInt(params, 'tokens')
  const tokensPerSecond = readInt(params, 'rate')
  const turnRequest: TurnRequestOptions = {
    ...(scenario.success ? { scenario: scenario.data } : {}),
    ...(seed === undefined ? {} : { seed }),
    ...(replyTokens === undefined ? {} : { replyTokens }),
    ...(tokensPerSecond === undefined ? {} : { tokensPerSecond }),
  }
  return {
    turnRequest,
    variant: parseVariant(params.get('v')),
    historyLimit: readInt(params, 'history'),
  }
}

const { turnRequest, variant, historyLimit } = readParams()

export function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>stream-chat-lab</h1>
        <span className="badge" data-testid="scenario">
          scenario: {turnRequest.scenario ?? 'normal'}
          {turnRequest.seed === undefined ? '' : ` · seed ${turnRequest.seed}`} · v{variant.version}
        </span>
      </header>
      <ChatView
        api={api}
        transport={eventSourceTransport}
        variant={variant}
        turnRequest={turnRequest}
        {...(historyLimit === undefined ? {} : { historyLimit })}
      />
    </main>
  )
}
