import {
  replyClientId,
  type Message,
  type Scenario,
  type ScenarioOptions,
  type TurnResponse,
  type TurnStatus,
} from '@stream-chat-lab/chat-protocol'
import { seedConversation, type ReplyOptions } from './reply'

export interface TurnRecord {
  id: string
  clientId: string
  scenario: Scenario
  seed: number
  replyOptions: ReplyOptions
  scenarioOptions: ScenarioOptions
  status: TurnStatus
  /** 스트림 구독 요청 수. 장애 시나리오는 첫 구독에만 적용한다. */
  subscriptions: number
  userMessage: Message
  assistantMessage: Message | null
}

export function createStore(options: {
  now: () => number
  seed: number
  seedMessageCount: number
}) {
  let messageSeq = 0
  let turnSeq = 0
  const messages: Message[] = []
  const turns = new Map<string, TurnRecord>()
  const turnIdByClientId = new Map<string, string>()

  function addMessage(role: Message['role'], clientId: string, text: string): Message {
    // id를 0으로 채워 문자열 정렬과 생성 순서가 같게 한다. 커서 비교에 쓴다.
    const message: Message = {
      id: `m${String(++messageSeq).padStart(6, '0')}`,
      clientId,
      role,
      text,
      createdAt: new Date(options.now()).toISOString(),
    }
    messages.push(message)
    return message
  }

  seedConversation(options.seed, options.seedMessageCount).forEach((m, i) =>
    addMessage(m.role, `seed-${i}`, m.text),
  )

  return {
    createTurn(input: {
      clientId: string
      text: string
      scenario: Scenario
      seed: number
      replyOptions: ReplyOptions
      scenarioOptions: ScenarioOptions
    }): TurnRecord {
      const turn: TurnRecord = {
        id: `t${String(++turnSeq).padStart(6, '0')}`,
        clientId: input.clientId,
        scenario: input.scenario,
        seed: input.seed,
        replyOptions: input.replyOptions,
        scenarioOptions: input.scenarioOptions,
        status: 'streaming',
        subscriptions: 0,
        userMessage: addMessage('user', input.clientId, input.text),
        assistantMessage: null,
      }
      turns.set(turn.id, turn)
      turnIdByClientId.set(turn.clientId, turn.id)
      return turn
    },

    completeTurn(turn: TurnRecord, text: string, options: { stopped?: boolean } = {}): Message {
      const message = addMessage('assistant', replyClientId(turn.clientId), text)
      if (options.stopped) message.stopped = true
      turn.status = 'completed'
      turn.assistantMessage = message
      return message
    },

    /** 응답을 만들기 전에 실패한 턴. 같은 clientId로 다시 보내면 같은 턴을 다시 쓴다. (docs/decisions/013) */
    failTurn(turn: TurnRecord): void {
      turn.status = 'failed'
    },

    retryTurn(turn: TurnRecord): void {
      turn.status = 'streaming'
    },

    getTurn(id: string): TurnRecord | undefined {
      return turns.get(id)
    },

    findTurnByClientId(clientId: string): TurnRecord | undefined {
      const id = turnIdByClientId.get(clientId)
      return id === undefined ? undefined : turns.get(id)
    },

    /** cursor보다 오래된 메시지 중 최신 limit개를 오래된 순으로 돌려준다. */
    page(
      cursor: string | undefined,
      limit: number,
    ): { messages: Message[]; nextCursor: string | null } {
      const older = cursor === undefined ? messages : messages.filter((m) => m.id < cursor)
      const page = older.slice(-limit)
      const first = page[0]
      return { messages: page, nextCursor: first && older.length > page.length ? first.id : null }
    },
  }
}

export function toTurnResponse(turn: TurnRecord): TurnResponse {
  return {
    id: turn.id,
    clientId: turn.clientId,
    status: turn.status,
    userMessage: turn.userMessage,
    assistantMessage: turn.assistantMessage,
  }
}
