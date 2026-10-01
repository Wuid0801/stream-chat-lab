import {
  createTurnResponseSchema,
  messagesPageSchema,
  turnResponseSchema,
} from '@stream-chat-lab/chat-protocol'
import type { ChatApi } from './types'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`API ${status}: ${code}`)
  }
}

export function createApiClient(options: { baseUrl: string; token: string }): ChatApi {
  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await fetch(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${options.token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    const body: unknown = await res.json().catch(() => null)
    if (!res.ok) {
      const code =
        typeof body === 'object' && body !== null && 'code' in body && typeof body.code === 'string'
          ? body.code
          : 'unknown'
      throw new ApiError(res.status, code)
    }
    return body
  }

  return {
    async createTurn(req, signal) {
      return createTurnResponseSchema.parse(
        await request('/turns', { method: 'POST', body: JSON.stringify(req), signal }),
      )
    },
    async getTurn(turnId) {
      return turnResponseSchema.parse(await request(`/turns/${encodeURIComponent(turnId)}`))
    },
    async getMessages(cursor) {
      const query = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      return messagesPageSchema.parse(await request(`/messages${query}`))
    },
    streamUrl(turnId, streamToken) {
      // 네이티브 EventSource는 헤더를 넣을 수 없어 1회용 토큰을 쿼리로 보낸다. (docs/protocol.md)
      return `${options.baseUrl}/turns/${encodeURIComponent(turnId)}/stream?token=${encodeURIComponent(streamToken)}`
    },
  }
}
