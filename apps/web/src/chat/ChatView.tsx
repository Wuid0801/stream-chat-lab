import type { Scenario } from '@stream-chat-lab/chat-protocol'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChatApi } from '../api/types'
import { chatReducer, initialChatState, selectDisplayMessages } from '../store/messages'
import type { StreamTransport } from '../stream/transport'
import { createTurnController, type TurnController } from '../turn/controller'
import { Composer } from './Composer'
import { MessageList } from './MessageList'

interface Props {
  api: ChatApi
  transport: StreamTransport
  scenario?: Scenario
  seed?: number
}

export function ChatView({ api, transport, scenario, seed }: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const [historyError, setHistoryError] = useState(false)
  const controllerRef = useRef<TurnController | null>(null)

  useEffect(() => {
    const controller = createTurnController({
      api,
      transport,
      ...(scenario === undefined ? {} : { scenario }),
      ...(seed === undefined ? {} : { seed }),
      callbacks: {
        onToken: (clientId, text) => dispatch({ type: 'stream-token', clientId, text }),
        onCompleted: (clientId, userMessage, assistantMessage) =>
          dispatch({ type: 'turn-completed', clientId, userMessage, assistantMessage }),
        onFailed: (clientId, reason) => dispatch({ type: 'turn-failed', clientId, reason }),
      },
    })
    controllerRef.current = controller
    // 언마운트(또는 페이지 이동) 시 진행 중인 턴과 연결을 정리한다.
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [api, transport, scenario, seed])

  useEffect(() => {
    let cancelled = false
    api.getMessages().then(
      (page) => {
        if (!cancelled) dispatch({ type: 'history-loaded', messages: page.messages })
      },
      () => {
        if (!cancelled) setHistoryError(true)
      },
    )
    return () => {
      cancelled = true
    }
  }, [api])

  const messages = useMemo(() => selectDisplayMessages(state), [state])
  const busy = state.streaming !== null || state.local.some((m) => m.status === 'pending')

  function startTurn(clientId: string, text: string) {
    const result = controllerRef.current?.send(text, clientId)
    if (result?.ok) dispatch({ type: 'send-started', clientId, text })
  }

  function retry(clientId: string) {
    const failed = state.local.find((m) => m.clientId === clientId && m.status === 'failed')
    if (failed) startTurn(clientId, failed.text)
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).catch(() => {
      // 클립보드 권한이 없으면 무시한다. 메시지는 화면에 그대로 남아 있다.
    })
  }

  return (
    <div className="chat">
      {historyError && (
        <p className="banner" role="alert">
          지난 메시지를 불러오지 못했습니다.
        </p>
      )}
      <MessageList messages={messages} onRetry={retry} onCopy={copy} />
      <Composer disabled={busy} onSend={(text) => startTurn(crypto.randomUUID(), text)} />
    </div>
  )
}
