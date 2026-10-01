import { scenarioSchema } from '@stream-chat-lab/chat-protocol'
import { createApiClient } from './api/client'
import { ChatView } from './chat/ChatView'
import { eventSourceTransport } from './stream/eventsource'

const api = createApiClient({
  baseUrl: import.meta.env.VITE_API_URL ?? 'http://localhost:8787',
  // 데모용 고정 토큰. 목 서버의 DEMO_TOKEN과 같다.
  token: 'demo-token',
})

function readParams() {
  const params = new URLSearchParams(window.location.search)
  const scenario = scenarioSchema.safeParse(params.get('scenario'))
  const seed = Number(params.get('seed'))
  return {
    scenario: scenario.success ? scenario.data : undefined,
    seed: params.has('seed') && Number.isInteger(seed) ? seed : undefined,
  }
}

const { scenario, seed } = readParams()

export function App() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>stream-chat-lab</h1>
        <span className="badge" data-testid="scenario">
          scenario: {scenario ?? 'normal'}
          {seed === undefined ? '' : ` · seed ${seed}`}
        </span>
      </header>
      <ChatView
        api={api}
        transport={eventSourceTransport}
        {...(scenario === undefined ? {} : { scenario })}
        {...(seed === undefined ? {} : { seed })}
      />
    </main>
  )
}
