// O quadro binário do WebSocket da tela: `FRAME_HEADER_BYTES` bytes com o tamanho
// do cabeçalho JSON (uint32 big-endian), o cabeçalho e a imagem.
import { FRAME_HEADER_BYTES, type FrameHeader } from '../../../shared/browser.js'

export function encodeFrame(h: FrameHeader, image: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify({ kind: h.kind, seq: h.seq, width: h.width, height: h.height }))
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + json.length + image.length)
  out.writeUInt32BE(json.length, 0)
  json.copy(out, FRAME_HEADER_BYTES)
  image.copy(out, FRAME_HEADER_BYTES + json.length)
  return out
}

/** O inverso do `encodeFrame` (só os testes usam; a web tem o seu). */
export function decodeFrame(buf: Buffer): { header: FrameHeader; image: Buffer } {
  const len = buf.readUInt32BE(0)
  const start = FRAME_HEADER_BYTES
  const header = JSON.parse(buf.subarray(start, start + len).toString('utf8')) as FrameHeader
  return { header, image: buf.subarray(start + len) }
}
