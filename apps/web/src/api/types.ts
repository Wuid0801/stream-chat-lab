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
  getMessages(options?: { cursor?: string; limit?: number }): Promise<MessagesPage>
}
