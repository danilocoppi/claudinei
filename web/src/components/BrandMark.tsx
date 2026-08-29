/**
 * O brasão do Claudinei — a "Divisa", partida na diagonal: metade estrela do
 * Claude, metade nó da OpenAI.
 *
 * Vem do MESMO arquivo que o favicon, e não de uma cópia do SVG aqui dentro: a
 * marca já existia na aba do navegador enquanto o cabeçalho mostrava um asterisco
 * genérico, e duas cópias voltariam a divergir na próxima vez que alguém mexesse
 * numa delas.
 *
 * Sem `currentColor` de propósito: as cores são da marca (creme, terracota,
 * tinta) e não devem virar a cor de destaque de cada tema.
 */
export function BrandMark({ size = 18 }: { size?: number }) {
  return (
    <img
      className="brand-mark"
      src="/favicon.svg"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  )
}
