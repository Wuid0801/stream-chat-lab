import { replyClientId, type Message } from '@stream-chat-lab/chat-protocol'

/** 아직 서버에서 확정되지 않은 사용자 메시지 */
export interface LocalMessage {
  clientId: string
  text: string
  status: 'pending' | 'failed'
  failReason?: string
}

export interface ChatState {
  /** 서버에서 확정된 메시지. id 오름차순, id 중복 없음 */
  server: Message[]
  /** 보낸 순서대로 */
  local: LocalMessage[]
  /** 응답이 스트리밍 중인 턴. clientId는 사용자 메시지의 clientId */
  streaming: { clientId: string; text: string } | null
  /** 더 오래된 페이지의 커서. undefined면 아직 모름, null이면 더 없음 */
  olderCursor: string | null | undefined
}

export type ChatAction =
  /** 최신 페이지. 처음 받았을 때만 커서를 기억한다. */
  | { type: 'history-loaded'; messages: Message[]; nextCursor?: string | null }
  /** 위로 불러온 과거 페이지 */
  | { type: 'older-loaded'; messages: Message[]; nextCursor: string | null }
  | { type: 'send-started'; clientId: string; text: string }
  | { type: 'stream-token'; clientId: string; text: string }
  | { type: 'turn-completed'; clientId: string; userMessage: Message; assistantMessage: Message }
  | { type: 'turn-failed'; clientId: string; reason: string }

export const initialChatState: ChatState = {
  server: [],
  local: [],
  streaming: null,
  olderCursor: undefined,
}

/** id로 합치고 정렬한다. 같은 메시지를 여러 경로(히스토리, final, 상태 조회)로 받아도 한 번만 남는다. */
function mergeServer(current: Message[], incoming: Message[]): Message[] {
  const byId = new Map(current.map((m) => [m.id, m]))
  // 서버 메시지는 저장된 뒤 바뀌지 않는다. 이미 있는 객체를 유지해야 표시용 객체도 유지된다.
  for (const m of incoming) if (!byId.has(m.id)) byId.set(m.id, m)
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * 서버 메시지와 대응하는 로컬 상태를 지운다. 매칭 기준은 clientId뿐이다.
 * 텍스트나 시각으로 매칭하지 않는다. (LEARNING.md 5장)
 */
function reconcile(state: ChatState, server: Message[]): ChatState {
  const confirmed = new Set(server.map((m) => m.clientId))
  const local = state.local.filter((m) => !confirmed.has(m.clientId))
  const streaming =
    state.streaming && confirmed.has(replyClientId(state.streaming.clientId))
      ? null
      : state.streaming
  return { ...state, server, local, streaming }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'history-loaded': {
      const next = reconcile(state, mergeServer(state.server, action.messages))
      const known = state.olderCursor !== undefined
      return known || action.nextCursor === undefined
        ? next
        : { ...next, olderCursor: action.nextCursor }
    }

    case 'older-loaded':
      return {
        ...reconcile(state, mergeServer(state.server, action.messages)),
        olderCursor: action.nextCursor,
      }

    case 'send-started': {
      const exists = state.local.some((m) => m.clientId === action.clientId)
      const local = exists
        ? // 재시도: 같은 clientId의 메시지를 다시 pending으로 돌린다.
          state.local.map((m): LocalMessage =>
            m.clientId === action.clientId
              ? { clientId: m.clientId, text: m.text, status: 'pending' }
              : m,
          )
        : [
            ...state.local,
            { clientId: action.clientId, text: action.text, status: 'pending' as const },
          ]
      return { ...state, local }
    }

    case 'stream-token': {
      // 응답이 이미 서버에서 확정됐다면(히스토리가 먼저 도착) 다시 그리지 않는다.
      const reply = replyClientId(action.clientId)
      if (state.server.some((m) => m.clientId === reply)) return state
      const prev = state.streaming?.clientId === action.clientId ? state.streaming.text : ''
      return { ...state, streaming: { clientId: action.clientId, text: prev + action.text } }
    }

    case 'turn-completed':
      return reconcile(
        state,
        mergeServer(state.server, [action.userMessage, action.assistantMessage]),
      )

    case 'turn-failed':
      return {
        ...state,
        local: state.local.map((m) =>
          m.clientId === action.clientId
            ? { ...m, status: 'failed', failReason: action.reason }
            : m,
        ),
        streaming: state.streaming?.clientId === action.clientId ? null : state.streaming,
      }
  }
}

export interface DisplayMessage {
  key: string
  clientId: string
  role: Message['role']
  text: string
  status: 'sent' | 'pending' | 'failed' | 'streaming'
  failReason?: string
  /** 사용자가 중지해 도중까지만 저장된 응답 */
  stopped?: boolean
}

/**
 * 원본 객체가 그대로면 표시용 객체도 그대로 돌려준다.
 * 토큰 하나에 지난 메시지 전체의 표시용 객체가 새로 만들어지면 memo가 아무것도 막지 못한다.
 */
const localCache = new WeakMap<LocalMessage, DisplayMessage>()
const serverCaches = {
  id: new WeakMap<Message, DisplayMessage>(),
  clientId: new WeakMap<Message, DisplayMessage>(),
}

function cached<T extends object>(
  cache: WeakMap<T, DisplayMessage>,
  source: T,
  build: () => DisplayMessage,
): DisplayMessage {
  let display = cache.get(source)
  if (!display) {
    display = build()
    cache.set(source, display)
  }
  return display
}

/**
 * 서버 메시지 → 로컬 메시지 → 스트리밍 말풍선 순으로 합친다.
 *
 * 렌더 key: 기본(v0~v3)은 서버 메시지에 서버 id를 쓴다. 확정될 때 key가 clientId → 서버 id로 바뀌어 리마운트된다.
 * stableKey(v4~)는 서버 메시지에도 echo된 clientId를 써서 확정 전후의 key가 같다. (docs/decisions/014)
 */
export function selectDisplayMessages(
  state: ChatState,
  options: { stableKey?: boolean } = {},
): DisplayMessage[] {
  const stableKey = options.stableKey ?? false
  const serverCache = stableKey ? serverCaches.clientId : serverCaches.id
  const result: DisplayMessage[] = state.server.map((m) =>
    cached(serverCache, m, () => ({
      key: stableKey ? m.clientId : m.id,
      clientId: m.clientId,
      role: m.role,
      text: m.text,
      status: 'sent',
      ...(m.stopped ? { stopped: true } : {}),
    })),
  )
  for (const m of state.local) {
    result.push(
      cached(localCache, m, () => ({
        key: m.clientId,
        clientId: m.clientId,
        role: 'user',
        text: m.text,
        status: m.status,
        ...(m.failReason === undefined ? {} : { failReason: m.failReason }),
      })),
    )
  }
  if (state.streaming) {
    const clientId = replyClientId(state.streaming.clientId)
    result.push({
      key: clientId,
      clientId,
      role: 'assistant',
      text: state.streaming.text,
      status: 'streaming',
    })
  }
  return result
}
