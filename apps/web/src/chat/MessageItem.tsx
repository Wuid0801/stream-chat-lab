import { memo, useEffect } from 'react'
import { bench } from '../bench/probe'
import type { DisplayMessage } from '../store/messages'
import { MessageBody } from './MessageBody'

interface Props {
  message: DisplayMessage
  markdown: boolean
  onRetry(clientId: string): void
  onCopy(text: string): void
}

export function MessageItem({ message, markdown, onRetry, onCopy }: Props) {
  useEffect(() => {
    // 측정 모드에서만 센다. key가 바뀌면 리마운트되어 이 값이 오른다.
    if (bench) bench.mounts++
  }, [])

  return (
    <li
      className={`message message--${message.role}`}
      data-testid="message"
      data-role={message.role}
      data-status={message.status}
    >
      <MessageBody text={message.text} markdown={markdown} />
      {message.status === 'pending' && <div className="meta">보내는 중…</div>}
      {message.status === 'failed' && (
        <div className="meta meta--failed" role="alert">
          <span>전송하지 못했습니다{message.failReason ? ` (${message.failReason})` : ''}</span>
          <button type="button" onClick={() => onRetry(message.clientId)}>
            재시도
          </button>
          <button type="button" onClick={() => onCopy(message.text)}>
            복사
          </button>
        </div>
      )}
    </li>
  )
}

/** v1부터 쓴다. props가 그대로인 지난 메시지는 다시 렌더하지 않는다. */
export const MemoMessageItem = memo(MessageItem)
