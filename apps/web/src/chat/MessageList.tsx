import { useEffect, useEffectEvent, useLayoutEffect, useRef } from 'react'
import type { DisplayMessage } from '../store/messages'
import type { RenderVariant } from '../variants/config'
import { MemoMessageItem, MessageItem } from './MessageItem'

/** 바닥에서 이 거리(px) 안에 있으면 "바닥 근처"로 본다 */
const BOTTOM_THRESHOLD = 48

interface Props {
  messages: DisplayMessage[]
  variant: RenderVariant
  /** 보냈지만 첫 토큰이 아직 오지 않았다 */
  waiting: boolean
  /** 더 오래된 메시지가 있다 */
  hasOlder: boolean
  /** 과거 페이지를 불러와 상태에 반영한다. 반영(dispatch)까지 끝나면 resolve된다. */
  onLoadOlder(): Promise<void>
  onRetry(clientId: string): void
  onCopy(text: string): void
}

/** 위로 불러오기 직전의 스크롤 상태 */
interface ScrollSnapshot {
  height: number
  top: number
  /** 이 값이 바뀐 렌더가 과거 페이지가 실제로 반영된 렌더다 */
  firstKey: string | undefined
}

export function MessageList({
  messages,
  variant,
  waiting,
  hasOlder,
  onLoadOlder,
  onRetry,
  onCopy,
}: Props) {
  const Item = variant.memoPast ? MemoMessageItem : MessageItem
  const listRef = useRef<HTMLDivElement>(null)
  const sentinelRef = useRef<HTMLLIElement>(null)
  const followRef = useRef(true)
  const lastScrollTopRef = useRef(0)
  const prevCountRef = useRef(0)
  const prevLastRef = useRef<{ key: string | undefined; length: number }>({
    key: undefined,
    length: 0,
  })
  const loadingRef = useRef(false)
  const pendingCorrectionRef = useRef<ScrollSnapshot | null>(null)

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

  // v5: 과거 페이지가 DOM에 반영된 직후, 페인트 전에 보정한다. (docs/decisions/015)
  useLayoutEffect(() => {
    const el = listRef.current
    const snapshot = pendingCorrectionRef.current
    if (!el || !snapshot || messages[0]?.key === snapshot.firstKey) return
    pendingCorrectionRef.current = null
    el.scrollTop = snapshot.top + (el.scrollHeight - snapshot.height)
    lastScrollTopRef.current = el.scrollTop
  }, [messages])

  // 바닥 따라가기
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prevCount = prevCountRef.current
    const prevLast = prevLastRef.current
    const last = messages.at(-1)
    prevCountRef.current = messages.length
    prevLastRef.current = { key: last?.key, length: last?.text.length ?? 0 }
    // scroll 이벤트는 다음 프레임에 온다. 사용자가 방금 위로 올렸는데 그 사이에 토큰이 도착하면,
    // 이벤트만 믿고 내려 버리게 된다. 그래서 렌더 시점에 위치를 다시 확인한다.
    updateFollow(el)
    if (!followRef.current) return
    // 위에 과거 페이지만 붙었으면(마지막 메시지가 그대로) 내리지 않는다.
    const bottomChanged =
      prevCount === 0 || last?.key !== prevLast.key || (last?.text.length ?? 0) !== prevLast.length
    if (!bottomChanged && !waiting) return
    // 새 메시지가 추가되면 부드럽게, 같은 메시지가 길어지는 중(토큰)에는 즉시 내린다.
    // 토큰마다 smooth로 내리면 애니메이션이 계속 처음부터 다시 시작된다.
    const added = prevCount !== 0 && last?.key !== prevLast.key
    el.scrollTo({ top: el.scrollHeight, behavior: added ? 'smooth' : 'auto' })
    lastScrollTopRef.current = el.scrollTop
  }, [messages, waiting])

  const loadOlder = useEffectEvent(async () => {
    const el = listRef.current
    if (!el || loadingRef.current || !hasOlder) return
    loadingRef.current = true
    const snapshot: ScrollSnapshot = {
      height: el.scrollHeight,
      top: el.scrollTop,
      firstKey: messages[0]?.key,
    }
    try {
      if (variant.layoutScrollCorrection) {
        pendingCorrectionRef.current = snapshot
        await onLoadOlder()
      } else {
        // v0~v4 (실무 방식): 요청이 끝난 뒤 다음 프레임에 보정한다.
        // React가 아직 새 메시지를 커밋하지 않았다면 이전 높이를 읽어 보정 값이 틀린다. (LEARNING.md 8장)
        await onLoadOlder()
        requestAnimationFrame(() => {
          el.scrollTop = snapshot.top + (el.scrollHeight - snapshot.height)
          lastScrollTopRef.current = el.scrollTop
        })
      }
    } finally {
      loadingRef.current = false
    }
  })

  // 맨 위 sentinel이 보이면 과거 페이지를 불러온다. scrollTop === 0 같은 조건보다 덜 민감하다.
  useEffect(() => {
    const root = listRef.current
    const target = sentinelRef.current
    if (!root || !target || !hasOlder) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadOlder()
      },
      { root },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [hasOlder])

  return (
    <div
      className="message-list"
      ref={listRef}
      onScroll={(e) => updateFollow(e.currentTarget)}
      data-testid="message-list"
    >
      <ol>
        {hasOlder && (
          <li ref={sentinelRef} className="sentinel" data-testid="sentinel" aria-hidden />
        )}
        {messages.map((m) => (
          <Item
            key={m.key}
            message={m}
            markdown={!(variant.plainWhileStreaming && m.status === 'streaming')}
            onRetry={onRetry}
            onCopy={onCopy}
          />
        ))}
        {waiting && (
          <li className="message message--assistant" data-testid="waiting" aria-live="polite">
            <div className="bubble bubble--waiting">응답을 기다리는 중…</div>
          </li>
        )}
      </ol>
    </div>
  )
}
