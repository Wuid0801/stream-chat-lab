import { Profiler, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChatApi } from '../api/types'
import { bench, recordCommit } from '../bench/probe'
import { chatReducer, initialChatState, selectDisplayMessages } from '../store/messages'
import { createTokenBatcher } from '../stream/token-batcher'
import type { StreamTransport } from '../stream/transport'
import {
  createTurnController,
  type TurnController,
  type TurnRequestOptions,
} from '../turn/controller'
import type { RenderVariant } from '../variants/config'
import { Composer } from './Composer'
import { MessageList } from './MessageList'

interface Props {
  api: ChatApi
  transport: StreamTransport
  variant: RenderVariant
  /** 턴 생성 요청에 함께 보낼 값. 렌더마다 새 객체를 넘기면 컨트롤러가 다시 만들어진다. */
  turnRequest: TurnRequestOptions
  /** 처음 불러올 지난 메시지 수 */
  historyLimit?: number
}

export function ChatView({ api, transport, variant, turnRequest, historyLimit }: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const [historyError, setHistoryError] = useState(false)
  const controllerRef = useRef<TurnController | null>(null)

  useEffect(() => {
    // v2부터 토큰을 프레임 단위로 모은다. 확정·실패를 반영하기 전에는 남은 토큰을 먼저 내보낸다.
    const batcher = variant.rafBatch
      ? createTokenBatcher({
          onFlush: (clientId, text) => dispatch({ type: 'stream-token', clientId, text }),
          requestFrame: (cb) => requestAnimationFrame(cb),
          cancelFrame: (id) => cancelAnimationFrame(id),
        })
      : null
    const controller = createTurnController({
      api,
      transport,
      turnRequest,
      callbacks: {
        onToken: (clientId, text) =>
          batcher
            ? batcher.push(clientId, text)
            : dispatch({ type: 'stream-token', clientId, text }),
        onCompleted: (clientId, userMessage, assistantMessage) => {
          batcher?.flush()
          dispatch({ type: 'turn-completed', clientId, userMessage, assistantMessage })
        },
        onFailed: (clientId, reason) => {
          batcher?.flush()
          dispatch({ type: 'turn-failed', clientId, reason })
        },
      },
    })
    controllerRef.current = controller
    // 언마운트(또는 페이지 이동) 시 진행 중인 턴과 연결, 예약된 프레임을 정리한다.
    return () => {
      controller.dispose()
      batcher?.dispose()
      controllerRef.current = null
    }
  }, [api, transport, turnRequest, variant])

  useEffect(() => {
    let cancelled = false
    api.getMessages(historyLimit === undefined ? {} : { limit: historyLimit }).then(
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
  }, [api, historyLimit])

  const messages = useMemo(() => selectDisplayMessages(state), [state])
  const busy = state.streaming !== null || state.local.some((m) => m.status === 'pending')

  function startTurn(clientId: string, text: string) {
    const result = controllerRef.current?.send(text, clientId)
    if (!result?.ok) return
    if (bench) bench.sentAt = performance.now()
    dispatch({ type: 'send-started', clientId, text })
  }

  // memo된 행에 넘기는 콜백은 토큰이 들어올 때 바뀌지 않아야 한다. (state.local은 토큰으로 바뀌지 않는다)
  const local = state.local
  const retry = useCallback(
    (clientId: string) => {
      const failed = local.find((m) => m.clientId === clientId && m.status === 'failed')
      if (!failed) return
      const result = controllerRef.current?.send(failed.text, clientId)
      if (result?.ok) dispatch({ type: 'send-started', clientId, text: failed.text })
    },
    [local],
  )

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      // 클립보드 권한이 없으면 무시한다. 메시지는 화면에 그대로 남아 있다.
    })
  }, [])

  const list = <MessageList messages={messages} variant={variant} onRetry={retry} onCopy={copy} />

  return (
    <div className="chat">
      {historyError && (
        <p className="banner" role="alert">
          지난 메시지를 불러오지 못했습니다.
        </p>
      )}
      {bench ? (
        <Profiler id="messages" onRender={recordCommit}>
          {list}
        </Profiler>
      ) : (
        list
      )}
      <Composer disabled={busy} onSend={(text) => startTurn(crypto.randomUUID(), text)} />
    </div>
  )
}
