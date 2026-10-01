import { replyClientId, type Message } from '@stream-chat-lab/chat-protocol'
import { describe, expect, it } from 'vitest'
import { chatReducer, initialChatState, selectDisplayMessages, type ChatAction } from './messages'

let seq = 0
function serverMessage(clientId: string, role: Message['role'], text: string): Message {
  return {
    id: `m${String(++seq).padStart(6, '0')}`,
    clientId,
    role,
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

function run(...actions: ChatAction[]) {
  return actions.reduce(chatReducer, initialChatState)
}

const view = (state: ReturnType<typeof run>) =>
  selectDisplayMessages(state).map((m) => `${m.role}:${m.status}:${m.text}`)

describe('낙관적 메시지', () => {
  it('보내면 바로 pending 사용자 메시지가 보인다', () => {
    const state = run({ type: 'send-started', clientId: 'c1', text: '안녕' })
    expect(view(state)).toEqual(['user:pending:안녕'])
  })

  it('토큰은 스트리밍 말풍선에 이어 붙는다', () => {
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '안녕' },
      { type: 'stream-token', clientId: 'c1', text: '반' },
      { type: 'stream-token', clientId: 'c1', text: '가워요' },
    )
    expect(view(state)).toEqual(['user:pending:안녕', 'assistant:streaming:반가워요'])
  })

  it('완료되면 clientId로 매칭해 pending과 스트리밍 말풍선을 서버 메시지로 바꾼다', () => {
    const user = serverMessage('c1', 'user', '안녕')
    const reply = serverMessage(replyClientId('c1'), 'assistant', '반가워요')
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '안녕' },
      { type: 'stream-token', clientId: 'c1', text: '반가워요' },
      { type: 'turn-completed', clientId: 'c1', userMessage: user, assistantMessage: reply },
    )
    expect(view(state)).toEqual(['user:sent:안녕', 'assistant:sent:반가워요'])
  })

  it('서버가 공백을 다듬어 텍스트가 달라도 clientId로 매칭한다', () => {
    const user = serverMessage('c1', 'user', '안녕')
    const reply = serverMessage(replyClientId('c1'), 'assistant', '네')
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '  안녕  ' },
      { type: 'turn-completed', clientId: 'c1', userMessage: user, assistantMessage: reply },
    )
    expect(view(state)).toEqual(['user:sent:안녕', 'assistant:sent:네'])
  })
})

describe('같은 텍스트', () => {
  it('같은 문장을 연속으로 보내면 둘 다 표시한다', () => {
    const u1 = serverMessage('c1', 'user', '다시')
    const r1 = serverMessage(replyClientId('c1'), 'assistant', '네')
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '다시' },
      { type: 'turn-completed', clientId: 'c1', userMessage: u1, assistantMessage: r1 },
      { type: 'send-started', clientId: 'c2', text: '다시' },
    )
    expect(view(state)).toEqual(['user:sent:다시', 'assistant:sent:네', 'user:pending:다시'])
  })
})

describe('순서가 뒤바뀐 응답', () => {
  it('히스토리가 완료보다 먼저 와도 중복이 없다', () => {
    const user = serverMessage('c1', 'user', '안녕')
    const reply = serverMessage(replyClientId('c1'), 'assistant', '반가워요')
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '안녕' },
      { type: 'stream-token', clientId: 'c1', text: '반가' },
      { type: 'history-loaded', messages: [user, reply] },
      { type: 'stream-token', clientId: 'c1', text: '워요' },
      { type: 'turn-completed', clientId: 'c1', userMessage: user, assistantMessage: reply },
    )
    expect(view(state)).toEqual(['user:sent:안녕', 'assistant:sent:반가워요'])
  })

  it('같은 서버 메시지를 두 번 받아도 한 번만 표시한다', () => {
    const m = serverMessage('seed-0', 'user', '예전 메시지')
    const state = run(
      { type: 'history-loaded', messages: [m] },
      { type: 'history-loaded', messages: [m] },
    )
    expect(view(state)).toEqual(['user:sent:예전 메시지'])
  })
})

describe('실패와 재시도', () => {
  it('실패하면 입력 내용을 그대로 둔 failed 메시지가 되고 스트리밍 말풍선은 사라진다', () => {
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '긴 질문' },
      { type: 'stream-token', clientId: 'c1', text: '부분' },
      { type: 'turn-failed', clientId: 'c1', reason: 'stream-failed' },
    )
    expect(view(state)).toEqual(['user:failed:긴 질문'])
  })

  it('재시도하면 같은 clientId의 메시지가 다시 pending이 된다 (새로 추가되지 않음)', () => {
    const state = run(
      { type: 'send-started', clientId: 'c1', text: '긴 질문' },
      { type: 'turn-failed', clientId: 'c1', reason: 'create-failed' },
      { type: 'send-started', clientId: 'c1', text: '긴 질문' },
    )
    expect(view(state)).toEqual(['user:pending:긴 질문'])
  })
})

describe('표시용 객체 유지 (memo가 동작하기 위한 조건)', () => {
  it('토큰이 늘어나도 바뀌지 않은 서버 메시지는 같은 객체를 돌려준다', () => {
    const history = [
      serverMessage('seed-a', 'user', '예전'),
      serverMessage('seed-b', 'assistant', '답'),
    ]
    const before = run(
      { type: 'history-loaded', messages: history },
      { type: 'send-started', clientId: 'c1', text: '새 질문' },
    )
    const after = chatReducer(before, { type: 'stream-token', clientId: 'c1', text: '토큰' })
    const [a0, a1] = selectDisplayMessages(before)
    const [b0, b1] = selectDisplayMessages(after)
    expect(b0).toBe(a0)
    expect(b1).toBe(a1)
  })

  it('같은 메시지를 히스토리로 다시 받아도 같은 객체를 돌려준다', () => {
    const m = serverMessage('seed-c', 'user', '예전')
    const first = run({ type: 'history-loaded', messages: [m] })
    const second = chatReducer(first, { type: 'history-loaded', messages: [{ ...m }] })
    expect(selectDisplayMessages(second)[0]).toBe(selectDisplayMessages(first)[0])
  })
})

describe('렌더 key (v4: clientId 승계)', () => {
  const keysOf = (state: ReturnType<typeof run>, stableKey: boolean) =>
    selectDisplayMessages(state, { stableKey }).map((m) => m.key)

  function beforeAndAfter() {
    const user = serverMessage('c-key', 'user', '질문')
    const reply = serverMessage(replyClientId('c-key'), 'assistant', '답')
    const before = run(
      { type: 'send-started', clientId: 'c-key', text: '질문' },
      { type: 'stream-token', clientId: 'c-key', text: '답' },
    )
    const after = chatReducer(before, {
      type: 'turn-completed',
      clientId: 'c-key',
      userMessage: user,
      assistantMessage: reply,
    })
    return { before, after }
  }

  it('stableKey면 확정 전후의 key가 같다 (리마운트 없음)', () => {
    const { before, after } = beforeAndAfter()
    expect(keysOf(after, true)).toEqual(keysOf(before, true))
  })

  it('기본(서버 id key)은 확정될 때 key가 바뀐다 (v0~v3의 기준 동작)', () => {
    const { before, after } = beforeAndAfter()
    expect(keysOf(after, false)).not.toEqual(keysOf(before, false))
  })
})

describe('과거 페이지', () => {
  it('최신 페이지의 커서를 기억하고, 과거 페이지를 앞에 합친다', () => {
    const older = [
      serverMessage('o1', 'user', '옛 질문'),
      serverMessage('o2', 'assistant', '옛 답'),
    ]
    const latest = [serverMessage('n1', 'user', '새 질문')]
    const first = run({
      type: 'history-loaded',
      messages: latest,
      nextCursor: latest[0]?.id ?? null,
    })
    expect(first.olderCursor).toBe(latest[0]?.id)

    const second = chatReducer(first, { type: 'older-loaded', messages: older, nextCursor: null })
    expect(view(second)).toEqual(['user:sent:옛 질문', 'assistant:sent:옛 답', 'user:sent:새 질문'])
    expect(second.olderCursor).toBeNull()
  })

  it('최신 페이지를 다시 받아도 이미 알고 있는 커서를 덮어쓰지 않는다', () => {
    const latest = [serverMessage('n2', 'user', '새 질문')]
    const older = [serverMessage('o3', 'user', '옛 질문')]
    const state = run(
      { type: 'history-loaded', messages: latest, nextCursor: 'c-latest' },
      { type: 'older-loaded', messages: older, nextCursor: 'c-older' },
      { type: 'history-loaded', messages: latest, nextCursor: 'c-latest' },
    )
    expect(state.olderCursor).toBe('c-older')
  })
})
