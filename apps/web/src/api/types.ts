import type {
  CreateTurnRequest,
  CreateTurnResponse,
  MessagesPage,
  TurnResponse,
} from '@stream-chat-lab/chat-protocol'

export interface ChatApi {
  createTurn(request: CreateTurnRequest, signal: AbortSignal): Promise<CreateTurnResponse>
  getTurn(turnId: string): Promise<TurnResponse>
  getMessages(options?: { cursor?: string; limit?: number }): Promise<MessagesPage>
  streamUrl(turnId: string, streamToken: string): string
}
