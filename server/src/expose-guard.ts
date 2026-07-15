/** Guarda de exposição: só bloqueia quando o host é acessível pela rede e não há auth. */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

export function assertExposureAllowed(
  host: string,
  opts: { insecure: boolean; authConfigured: boolean },
): void {
  if (isLoopbackHost(host) || opts.authConfigured || opts.insecure) return
  throw new Error(
    'Recusando expor na rede sem autenticação: as sessões rodam com --dangerously-skip-permissions ' +
    'e há terminal com shell real, então isso daria a qualquer um na rede controle total da sua máquina. ' +
    'A autenticação chega no próximo incremento. Para forçar mesmo assim (rede confiável, por sua conta e ' +
    'risco), suba com --insecure.',
  )
}
