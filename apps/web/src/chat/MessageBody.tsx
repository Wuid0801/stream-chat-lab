import Markdown from 'react-markdown'

interface Props {
  text: string
  /** false면 평문으로 그린다. 스트리밍 중 마크다운 재파싱 비용을 줄이는 v3 기법이다. */
  markdown: boolean
}

export function MessageBody({ text, markdown }: Props) {
  if (!markdown) return <div className="bubble">{text}</div>
  return (
    <div className="bubble bubble--markdown">
      <Markdown>{text}</Markdown>
    </div>
  )
}
