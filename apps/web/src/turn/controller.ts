import type { CreateTurnRequest, Message, StreamEvent } from '@stream-chat-lab/chat-protocol'
import type { ChatApi } from '../api/types'
import type { StreamConnection, StreamErrorInfo, StreamTransport } from '../stream/transport'

export type TurnStatus =
  | 'preparing'
  | 'streaming'
  | 'resuming'
  | 'reconciling'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'aborted'

/** 한 번의 "보내기 → 스트림 → 서버 상태 확인"을 끝까지 소유하는 객체 */
export interface Turn {
  readonly clientId: string
  /** 서버가 정한 턴 id. 준비가 끝나기 전에는 null */
  readonly id: string | null
  readonly status: TurnStatus
  /** 진행 중인 턴을 취소한다. 사용자 메시지는 failed('aborted')로 남는다. */
  abort(): void
  /**
   * 사용자가 중지한다. 서버가 거기까지의 응답을 저장하고, 그 응답으로 완료한다. (docs/decisions/016)
   * 서버에 턴이 아직 없으면(준비 중) abort와 같다.
   */
  cancel(): void
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
  /** 턴 생성 요청에 함께 보낼 값 (시나리오, seed, 측정 조건) */
  turnRequest?: TurnRequestOptions
  warn?: (message: string) => void
  /** 이어 받기 대기용. 테스트에서 바꿔 끼운다. */
  sleep?: (ms: number) => Promise<void>
}

export type TurnRequestOptions = Omit<CreateTurnRequest, 'clientId' | 'text'>

export type SendResult = { ok: true; turn: Turn } | { ok: false; reason: 'busy' }

/** 이어 받기 대기 시간. 횟수만큼 시도한 뒤에는 서버 상태를 확인한다. */
const RESUME_DELAYS_MS = [500, 1000, 2000] as const

/**
 * 턴을 한 번에 하나만 진행한다.
 *
 * - 동기 예약: send는 첫 await 전에 active를 잡는다. 준비 중 두 번째 send는 거부된다.
 * - 세대 번호: 턴이 끝나거나 취소될 때마다 generation이 오른다. 콜백은 자기 세대일 때만 동작한다.
 * - 턴 전용 상태: 받은 이벤트, 이어 받기 위치 등은 턴마다 새로 만드는 지역 변수에 둔다. (LEARNING.md 6장)
 * - 끊기면: 토큰을 받는 중이었다면 같은 턴을 이어 받고, 실패하면 서버 상태를 확인한다. (docs/decisions/011)
 */
export function createTurnController(options: TurnControllerOptions) {
  const { api, transport, callbacks } = options
  const warn = options.warn ?? ((message: string) => console.warn(message))
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))

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
    let lastEventId: string | null = null
    let nextSeq = 0
    let streamedText = ''
    let resumeAttempts = 0
    /** 중지를 요청한 뒤에는 스트림 콜백과 이어 받기를 멈춘다. 결과는 중지 응답이 정한다. */
    const isLive = () => isCurrent() && status !== 'cancelling'

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
          // 이어 받으며 같은 토큰을 다시 받으면 무시한다. 서버는 lastEventId 다음부터 보내지만 방어한다.
          if (event.seq < nextSeq) return
          if (event.seq > nextSeq)
            warn(`[stream] 계약 위반: 토큰 ${nextSeq}~${event.seq - 1}이 빠졌다`)
          nextSeq = event.seq + 1
          received.token = true
          streamedText += event.text
          callbacks.onToken(clientId, event.text)
          return
        case 'done':
          // 종료 신호가 아니다. final을 기다린다.
          received.done = true
          return
        case 'final':
          if (received.token && streamedText !== event.assistantMessage.text) {
            warn(`[stream] 계약 위반: 턴 ${event.turnId}의 스트림 텍스트와 확정 텍스트가 다르다`)
          }
          complete(event.userMessage, event.assistantMessage)
          return
        case 'error':
          fail(event.code)
          return
      }
    }

    function openStream(id: string, streamToken: string): void {
      connection = transport.open(
        { turnId: id, streamToken, lastEventId },
        {
          onEvent: (event, eventId) => {
            if (!isLive()) return
            lastEventId = eventId
            resumeAttempts = 0
            handleEvent(event)
          },
          onInvalid: (data, reason) => {
            if (isLive()) warn(`[stream] 계약 위반: 해석할 수 없는 이벤트 (${reason}): ${data}`)
          },
          onError: (info) => {
            if (isLive()) void handleDisconnect(id, info)
          },
        },
      )
    }

    async function reconcile(id: string): Promise<void> {
      // 응답을 받기 시작했다면 서버에 이미 저장됐을 수 있다. 확인한 뒤 판단한다. (오탐 복구)
      status = 'reconciling'
      try {
        const turn = await api.getTurn(id)
        if (!isLive()) return
        if (turn.status === 'completed' && turn.assistantMessage) {
          complete(turn.userMessage, turn.assistantMessage)
        } else {
          fail('stream-dropped')
        }
      } catch {
        if (isCurrent()) fail('reconcile-failed')
      }
    }

    async function handleDisconnect(id: string, info: StreamErrorInfo): Promise<void> {
      // 자동 재연결은 같은 1회용 토큰을 다시 쓰므로 즉시 닫는다. 다시 구독할지는 여기서 정한다.
      connection?.close()
      connection = null

      if (info.status === 401) return fail('unauthorized')
      if (info.status !== undefined && info.status >= 500) return fail('server-error')
      if (received.done) {
        warn(`[stream] 계약 위반: 턴 ${id}에서 final 없이 done 뒤에 연결이 닫혔다`)
        return reconcile(id)
      }
      if (!received.token) return fail('stream-failed')

      // 응답을 받는 중에 끊겼다. 턴을 다시 만들지 않고 받은 곳 다음부터 이어 받는다.
      const delay = RESUME_DELAYS_MS[resumeAttempts]
      if (delay === undefined) return reconcile(id)
      resumeAttempts++
      status = 'resuming'
      await sleep(delay)
      if (!isLive()) return
      try {
        const streamToken = await api.renewStreamToken(id)
        if (!isLive()) return
        status = 'streaming'
        openStream(id, streamToken)
      } catch {
        if (isLive()) await handleDisconnect(id, { reason: 'network' })
      }
    }

    async function start(): Promise<void> {
      try {
        const created = await api.createTurn(
          { ...options.turnRequest, clientId, text },
          abortController.signal,
        )
        // 준비 중에 취소됐다면 연결을 만들지 않는다.
        if (!isCurrent()) return
        turnId = created.turnId
        status = 'streaming'
        openStream(created.turnId, created.streamToken)
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
      cancel() {
        if (!isLive()) return
        const id = turnId
        if (id === null) return turn.abort()
        connection?.close()
        connection = null
        status = 'cancelling'
        void (async () => {
          try {
            const stopped = await api.cancelTurn(id)
            if (!isCurrent()) return
            if (stopped.status === 'completed' && stopped.assistantMessage) {
              complete(stopped.userMessage, stopped.assistantMessage)
            } else {
              fail('cancel-failed')
            }
          } catch {
            if (isCurrent()) fail('cancel-failed')
          }
        })()
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
