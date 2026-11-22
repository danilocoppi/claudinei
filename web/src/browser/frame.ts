import { FRAME_HEADER_BYTES, type FrameHeader } from '../../../shared/browser'

/**
 * Um quadro binário do socket da tela: `FRAME_HEADER_BYTES` bytes com o tamanho
 * do cabeçalho JSON (uint32 big-endian), o cabeçalho e a imagem. A imagem vira
 * `Blob` sem cópia (uma vista sobre o mesmo buffer): JPEG do `frame`, PNG do `still`.
 */
export function parseFrame(buf: ArrayBuffer): { header: FrameHeader; image: Blob } {
  const len = new DataView(buf).getUint32(0, false)
  const start = FRAME_HEADER_BYTES
  const raw = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, start, len))) as FrameHeader
  const header: FrameHeader = { kind: raw.kind === 'still' ? 'still' : 'frame', seq: Number(raw.seq), width: Number(raw.width), height: Number(raw.height) }
  const image = new Blob([new Uint8Array(buf, start + len)], { type: header.kind === 'still' ? 'image/png' : 'image/jpeg' })
  return { header, image }
}
