import type { StreamEvent } from '@stream-chat-lab/chat-protocol'

export interface StreamTarget {
  turnId: string
  streamToken: string
  /** 이어 받기: 마지막으로 받은 이벤트 id. 처음 구독이면 null */
  lastEventId: string | null
}

export interface StreamErrorInfo {
  /** HTTP 상태 코드. fetch 어댑터만 알 수 있다. 네이티브 EventSource는 상태 코드를 주지 않는다. */
  status?: number
  /** closed: 서버가 연결을 닫음, network: 네트워크 오류, idle-timeout: 일정 시간 아무것도 오지 않음 */
  reason?: 'closed' | 'network' | 'idle-timeout'
}

export interface StreamHandlers {
  onEvent(event: StreamEvent, id: string): void
  /** 계약에 맞지 않는 data를 받았다 */
  onInvalid(data: string, reason: string): void
  /** 연결이 끝났다. 정상 종료(서버가 닫음)에도 발생한다. */
  onError(info: StreamErrorInfo): void
}

export interface StreamConnection {
  close(): void
}

/** 전송 방식(EventSource, fetch 스트림)을 바꿔 끼우기 위한 인터페이스 */
export interface StreamTransport {
  open(target: StreamTarget, handlers: StreamHandlers): StreamConnection
}
