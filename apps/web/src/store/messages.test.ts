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
