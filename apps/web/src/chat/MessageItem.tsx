import type { DisplayMessage } from '../store/messages'

interface Props {
  message: DisplayMessage
  onRetry(clientId: string): void
  onCopy(text: string): void
}

export function MessageItem({ message, onRetry, onCopy }: Props) {
  return (
    <li
      className={`message message--${message.role}`}
      data-testid="message"
      data-role={message.role}
      data-status={message.status}
    >
      <div className="bubble">{message.text}</div>
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
