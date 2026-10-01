import type { StreamEvent } from '@stream-chat-lab/chat-protocol'

export interface StreamHandlers {
  onEvent(event: StreamEvent): void
  /** 계약에 맞지 않는 data를 받았다 */
  onInvalid(data: string, reason: string): void
  /** 연결 오류. 정상 종료(서버가 닫음)에도 발생한다. */
  onError(): void
}

export interface StreamConnection {
  close(): void
}

/** 전송 방식(EventSource, fetch 스트림)을 바꿔 끼우기 위한 인터페이스 */
export interface StreamTransport {
  open(url: string, handlers: StreamHandlers): StreamConnection
}
