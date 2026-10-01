import { useLayoutEffect, useRef } from 'react'
import type { DisplayMessage } from '../store/messages'
import { MessageItem } from './MessageItem'

/** 바닥에서 이 거리(px) 안에 있으면 "바닥 근처"로 본다 */
const BOTTOM_THRESHOLD = 48

interface Props {
  messages: DisplayMessage[]
  onRetry(clientId: string): void
  onCopy(text: string): void
}

export function MessageList({ messages, onRetry, onCopy }: Props) {
  const listRef = useRef<HTMLDivElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const prevCountRef = useRef(0)

  /** 현재 스크롤 위치로 "바닥 따라가기" 여부를 갱신한다. */
  function updateFollow(el: HTMLDivElement) {
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    const movedUp = el.scrollTop < lastScrollTopRef.current
    lastScrollTopRef.current = el.scrollTop
    // 바닥 근처면 따라가기를 켠다. 끄는 것은 사용자가 위로 올렸을 때뿐이다.
    // smooth 스크롤이 진행되는 동안에도 거리가 잠시 멀어지므로, 거리만 보면 따라가기가 꺼진다.
    if (distance <= BOTTOM_THRESHOLD) followRef.current = true
    else if (movedUp) followRef.current = false
  }

  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prevCount = prevCountRef.current
    prevCountRef.current = messages.length
    // scroll 이벤트는 다음 프레임에 온다. 사용자가 방금 위로 올렸는데 그 사이에 토큰이 도착하면,
    // 이벤트만 믿고 내려 버리게 된다. 그래서 렌더 시점에 위치를 다시 확인한다.
    updateFollow(el)
    if (!followRef.current) return
    // 새 메시지가 추가되면 부드럽게, 같은 메시지가 길어지는 중(토큰)에는 즉시 내린다.
    // 토큰마다 smooth로 내리면 애니메이션이 계속 처음부터 다시 시작된다.
    const added = prevCount !== 0 && messages.length > prevCount
    el.scrollTo({ top: el.scrollHeight, behavior: added ? 'smooth' : 'auto' })
    lastScrollTopRef.current = el.scrollTop
  }, [messages])

  return (
    <div
      className="message-list"
      ref={listRef}
      onScroll={(e) => updateFollow(e.currentTarget)}
      data-testid="message-list"
    >
      <ol>
        {messages.map((m) => (
          <MessageItem key={m.key} message={m} onRetry={onRetry} onCopy={onCopy} />
        ))}
      </ol>
    </div>
  )
}
