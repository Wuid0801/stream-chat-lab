import { Profiler, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ChatApi } from '../api/types'
import { bench, recordCommit } from '../bench/probe'
import { chatReducer, initialChatState, selectDisplayMessages } from '../store/messages'
import { createTokenBatcher } from '../stream/token-batcher'
import type { StreamTransport } from '../stream/transport'
import {
  createTurnController,
  type Turn,
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
  /** out-of-order-history: 처음 히스토리 응답을 서버가 늦춘다 */
  historyDelayMs?: number
}

/** 위로 불러올 때 한 번에 가져오는 메시지 수 */
const OLDER_PAGE_SIZE = 50

export function ChatView({
  api,
  transport,
  variant,
  turnRequest,
  historyLimit,
  historyDelayMs,
}: Props) {
  const [state, dispatch] = useReducer(chatReducer, initialChatState)
  const [historyError, setHistoryError] = useState(false)
  const controllerRef = useRef<TurnController | null>(null)
  /** 진행 중인 턴. 중지 버튼이 쓴다. */
  const turnRef = useRef<Turn | null>(null)

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
    api
      .getMessages({
        ...(historyLimit === undefined ? {} : { limit: historyLimit }),
        ...(historyDelayMs === undefined ? {} : { delayMs: historyDelayMs }),
      })
      .then(
        (page) => {
          if (!cancelled) {
            dispatch({
              type: 'history-loaded',
              messages: page.messages,
              nextCursor: page.nextCursor,
            })
          }
        },
        () => {
          if (!cancelled) setHistoryError(true)
        },
      )
    return () => {
      cancelled = true
    }
  }, [api, historyLimit, historyDelayMs])

  const messages = useMemo(
    () => selectDisplayMessages(state, { stableKey: variant.stableKey }),
    [state, variant.stableKey],
  )
  const busy = state.streaming !== null || state.local.some((m) => m.status === 'pending')

  function startTurn(clientId: string, text: string) {
    const result = controllerRef.current?.send(text, clientId)
    if (!result?.ok) return
    turnRef.current = result.turn
    if (bench) {
      bench.sentAt = performance.now()
      bench.mountsAtSend = bench.mounts
    }
    dispatch({ type: 'send-started', clientId, text })
  }

  // memo된 행에 넘기는 콜백은 토큰이 들어올 때 바뀌지 않아야 한다. (state.local은 토큰으로 바뀌지 않는다)
  const local = state.local
  const retry = useCallback(
    (clientId: string) => {
      const failed = local.find((m) => m.clientId === clientId && m.status === 'failed')
      if (!failed) return
      const result = controllerRef.current?.send(failed.text, clientId)
      if (!result?.ok) return
      turnRef.current = result.turn
      dispatch({ type: 'send-started', clientId, text: failed.text })
    },
    [local],
  )

  const copy = useCallback((text: string) => {
    navigator.clipboard.writeText(text).catch(() => {
      // 클립보드 권한이 없으면 무시한다. 메시지는 화면에 그대로 남아 있다.
    })
  }, [])

  const olderCursor = state.olderCursor
  const loadOlder = useCallback(async () => {
    if (!olderCursor) return
    try {
      const page = await api.getMessages({ cursor: olderCursor, limit: OLDER_PAGE_SIZE })
      dispatch({ type: 'older-loaded', messages: page.messages, nextCursor: page.nextCursor })
    } catch {
      // 실패하면 커서를 그대로 둔다. 다시 위로 스크롤하면 다시 시도한다.
    }
  }, [api, olderCursor])

  const waiting = state.streaming === null && state.local.some((m) => m.status === 'pending')
  const list = (
    <MessageList
      messages={messages}
      variant={variant}
      waiting={waiting}
      hasOlder={Boolean(olderCursor)}
      onLoadOlder={loadOlder}
      onRetry={retry}
      onCopy={copy}
    />
  )

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
      <Composer
        busy={busy}
        onSend={(text) => startTurn(crypto.randomUUID(), text)}
        onStop={() => turnRef.current?.cancel()}
      />
    </div>
  )
}
