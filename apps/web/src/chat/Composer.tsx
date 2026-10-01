import { useState } from 'react'
import { shouldSubmit } from './keys'

interface Props {
  /** 진행 중인 턴이 있으면 보낼 수 없다. 입력은 계속할 수 있다. */
  disabled: boolean
  onSend(text: string): void
}

export function Composer({ disabled, onSend }: Props) {
  const [text, setText] = useState('')
  const canSend = !disabled && text.trim() !== ''

  function submit() {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <textarea
        aria-label="메시지 입력"
        placeholder="메시지를 입력하세요"
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          const submitKey = shouldSubmit({
            key: e.key,
            shiftKey: e.shiftKey,
            isComposing: e.nativeEvent.isComposing,
            // keyCode는 표준에서 deprecated지만 IME 조합(229) 판별에는 아직 필요하다.
            keyCode: e.keyCode,
          })
          if (!submitKey) return
          e.preventDefault()
          submit()
        }}
      />
      <button type="submit" disabled={!canSend}>
        보내기
      </button>
    </form>
  )
}
