export interface SubmitKeyEvent {
  key: string
  shiftKey: boolean
  /** KeyboardEvent.isComposing (React에서는 e.nativeEvent.isComposing) */
  isComposing: boolean
  keyCode: number
}

/**
 * 입력창에서 이 키로 전송할지 정한다.
 * IME 조합 중의 Enter를 전송으로 처리하면 마지막 글자가 잘린 채 전송된다.
 * 일부 브라우저는 조합을 확정하는 Enter에서 isComposing을 false로 주므로 keyCode 229도 함께 본다.
 */
export function shouldSubmit(e: SubmitKeyEvent): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229
}
