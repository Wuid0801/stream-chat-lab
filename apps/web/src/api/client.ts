import {
  createTurnResponseSchema,
  messagesPageSchema,
  streamTokenResponseSchema,
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
    async getMessages(page = {}) {
      const params = new URLSearchParams()
      if (page.cursor !== undefined) params.set('cursor', page.cursor)
      if (page.limit !== undefined) params.set('limit', String(page.limit))
      if (page.delayMs !== undefined) params.set('delayMs', String(page.delayMs))
      const query = params.size === 0 ? '' : `?${params.toString()}`
      return messagesPageSchema.parse(await request(`/messages${query}`))
    },
    async cancelTurn(turnId) {
      return turnResponseSchema.parse(
        await request(`/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST' }),
      )
    },
    async renewStreamToken(turnId) {
      const body = await request(`/turns/${encodeURIComponent(turnId)}/stream-token`, {
        method: 'POST',
      })
      return streamTokenResponseSchema.parse(body).streamToken
    },
  }
}
