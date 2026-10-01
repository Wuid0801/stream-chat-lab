import type { Message, Scenario, StreamEvent } from '@stream-chat-lab/chat-protocol'
import type { ChatApi } from '../api/types'
import type { StreamConnection, StreamTransport } from '../stream/transport'

export type TurnStatus =
  'preparing' | 'streaming' | 'reconciling' | 'completed' | 'failed' | 'aborted'

/** 한 번의 "보내기 → 스트림 → 서버 상태 확인"을 끝까지 소유하는 객체 */
export interface Turn {
  readonly clientId: string
  /** 서버가 정한 턴 id. 준비가 끝나기 전에는 null */
  readonly id: string | null
  readonly status: TurnStatus
  /** 진행 중인 턴을 취소한다. 사용자 메시지는 failed('aborted')로 남는다. */
  abort(): void
}

export interface TurnCallbacks {
  onToken(clientId: string, text: string): void
  onCompleted(clientId: string, userMessage: Message, assistantMessage: Message): void
  onFailed(clientId: string, reason: string): void
}

export interface TurnControllerOptions {
  api: ChatApi
  transport: StreamTransport
  callbacks: TurnCallbacks
  scenario?: Scenario
  seed?: number
  warn?: (message: string) => void
}

export type SendResult = { ok: true; turn: Turn } | { ok: false; reason: 'busy' }

/**
 * 턴을 한 번에 하나만 진행한다.
 *
 * - 동기 예약: send는 첫 await 전에 active를 잡는다. 준비 중 두 번째 send는 거부된다.
 * - 세대 번호: 턴이 끝나거나 취소될 때마다 generation이 오른다. 콜백은 자기 세대일 때만 동작한다.
 * - 턴 전용 상태: gotToken 등은 턴마다 새로 만드는 지역 객체에 둔다. (LEARNING.md 6장)
 */
export function createTurnController(options: TurnControllerOptions) {
  const { api, transport, callbacks } = options
  const warn = options.warn ?? ((message: string) => console.warn(message))

  let generation = 0
  let active: { end(): void } | null = null

  function send(text: string, clientId: string): SendResult {
    if (active) return { ok: false, reason: 'busy' }

    const my = ++generation
    const isCurrent = () => my === generation
    const abortController = new AbortController()
    let connection: StreamConnection | null = null
    let turnId: string | null = null
    let status: TurnStatus = 'preparing'
    const received = { token: false, done: false }

    /** 턴을 끝낸다. 연결을 닫고, 세대를 올려 늦게 오는 콜백을 막고, 예약을 푼다. */
    function end(next: TurnStatus): void {
      status = next
      connection?.close()
      connection = null
      abortController.abort()
      generation++
      active = null
    }

    const complete = (user: Message, assistant: Message) => {
      end('completed')
      callbacks.onCompleted(clientId, user, assistant)
    }
    const fail = (reason: string) => {
      end('failed')
      callbacks.onFailed(clientId, reason)
    }

    function handleEvent(event: StreamEvent): void {
      switch (event.type) {
        case 'token':
          received.token = true
          callbacks.onToken(clientId, event.text)
          return
        case 'done':
          // 종료 신호가 아니다. final을 기다린다.
          received.done = true
          return
        case 'final':
          complete(event.userMessage, event.assistantMessage)
          return
        case 'error':
          fail(event.code)
          return
      }
    }

    async function handleDisconnect(id: string): Promise<void> {
      // 자동 재연결은 같은 턴을 다시 구독(= 1회용 토큰 재사용)하므로 즉시 닫는다.
      connection?.close()
      connection = null

      if (received.done) warn(`[stream] 계약 위반: 턴 ${id}에서 final 없이 done 뒤에 연결이 닫혔다`)
      if (!received.token && !received.done) {
        fail('stream-failed')
        return
      }

      // 응답을 받기 시작했다면 서버에 이미 저장됐을 수 있다. 확인한 뒤 판단한다. (오탐 복구)
      status = 'reconciling'
      try {
        const turn = await api.getTurn(id)
        if (!isCurrent()) return
        if (turn.status === 'completed' && turn.assistantMessage) {
          complete(turn.userMessage, turn.assistantMessage)
        } else {
          fail('stream-dropped')
        }
      } catch {
        if (isCurrent()) fail('reconcile-failed')
      }
    }

    async function start(): Promise<void> {
      try {
        const created = await api.createTurn(
          {
            clientId,
            text,
            ...(options.scenario === undefined ? {} : { scenario: options.scenario }),
            ...(options.seed === undefined ? {} : { seed: options.seed }),
          },
          abortController.signal,
        )
        // 준비 중에 취소됐다면 연결을 만들지 않는다.
        if (!isCurrent()) return
        const id = created.turnId
        turnId = id
        status = 'streaming'
        connection = transport.open(api.streamUrl(id, created.streamToken), {
          onEvent: (event) => {
            if (isCurrent()) handleEvent(event)
          },
          onInvalid: (data, reason) => {
            if (isCurrent()) warn(`[stream] 계약 위반: 해석할 수 없는 이벤트 (${reason}): ${data}`)
          },
          onError: () => {
            if (isCurrent()) void handleDisconnect(id)
          },
        })
      } catch {
        // 실패 경로에서도 예약을 반드시 푼다. 이미 취소됐다면 end()가 풀었다.
        if (isCurrent()) fail('create-failed')
      }
    }

    active = { end: () => end('aborted') }
    void start()

    const turn: Turn = {
      clientId,
      get id() {
        return turnId
      },
      get status() {
        return status
      },
      abort() {
        if (!isCurrent()) return
        end('aborted')
        callbacks.onFailed(clientId, 'aborted')
      },
    }
    return { ok: true, turn }
  }

  return {
    send,
    /** 언마운트 시 호출한다. 진행 중인 턴을 콜백 없이 정리한다. */
    dispose(): void {
      active?.end()
    },
  }
}

export type TurnController = ReturnType<typeof createTurnController>
