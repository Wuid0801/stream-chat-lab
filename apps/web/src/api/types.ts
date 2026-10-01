import type {
  CreateTurnRequest,
  CreateTurnResponse,
  MessagesPage,
  TurnResponse,
} from '@stream-chat-lab/chat-protocol'

export interface ChatApi {
  createTurn(request: CreateTurnRequest, signal: AbortSignal): Promise<CreateTurnResponse>
  getTurn(turnId: string): Promise<TurnResponse>
  /** 이어 받기용 새 1회용 토큰 */
  renewStreamToken(turnId: string): Promise<string>
  /** delayMs: out-of-order-history 시나리오용으로 서버 응답을 늦춘다 */
  getMessages(options?: {
    cursor?: string
    limit?: number
    delayMs?: number
  }): Promise<MessagesPage>
}
