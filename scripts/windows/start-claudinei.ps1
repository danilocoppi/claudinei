# Launcher do Claudinei para o autostart do Windows (Agendador de Tarefas).
# Roda no logon e, de novo, a cada poucos minutos: se o servidor já está no ar e
# respondendo, sai sem fazer nada; se caiu, sobe. É o que mantém o serviço vivo.
#
# O servidor sobe SEM JANELA e com CONSOLE PRÓPRIO (CREATE_NO_WINDOW), via cmd só
# para redirecionar os logs. Console próprio é de propósito: com -NoNewWindow ele
# herdava o console deste powershell, e um evento de console ali (Ctrl-C, fechamento,
# fim de sessão) derrubava o servidor junto — foi assim que a primeira versão morreu
# com 0xC000013A (STATUS_CONTROL_C_EXIT).
#
# Argumentos extras (--host/--port/--insecure) são repassados ao bin/claudinei.mjs.
# `-Force` derruba a instância no ar mesmo saudável (usado pelo restart).
$ErrorActionPreference = 'Stop'

# PRIMEIRA COISA: garantir que não sobre janela. A tarefa roda dentro de
# `conhost --headless` (ver install-autostart.ps1), que já não cria janela; este
# SW_HIDE é a rede de segurança para quem executar o script à mão num console
# clássico. Não confie nele sozinho: quando o Windows Terminal é o terminal padrão,
# GetConsoleWindow() devolve um PseudoConsoleWindow (proxy invisível) e a janela
# real é do WindowsTerminal.exe — esconder o proxy não muda nada. Por isso o
# resultado vai para o boot.log em vez de ser engolido por um catch mudo.
$janelaVisivel = $null
try {
  $win = Add-Type -Name ClWin -Namespace Cl -PassThru -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
'@
  $h = $win::GetConsoleWindow()
  if ($h -ne [IntPtr]::Zero) {
    [void]$win::ShowWindow($h, 0)   # 0 = SW_HIDE
    $janelaVisivel = $win::IsWindowVisible($h)
  }
} catch { $janelaVisivel = "falhou: $($_.Exception.Message)" }

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts/windows -> raiz do repo
$entry = Join-Path $root 'bin\claudinei.mjs'
$logDir = Join-Path $env:USERPROFILE '.claudinei\logs'
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Force -Path $logDir | Out-Null }
$log = Join-Path $logDir 'claudinei.log'
$errLog = Join-Path $logDir 'claudinei.err.log'
$bootLog = Join-Path $logDir 'boot.log'

function Boot([string]$msg) {
  Add-Content -Encoding utf8 -Path $bootLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $msg"
}

# -Force é do launcher; o resto vai para o node
$force = $false
$nodeArgs = @()
foreach ($a in $args) { if ($a -eq '-Force') { $force = $true } else { $nodeArgs += $a } }

$port = 9105
$portIdx = [Array]::IndexOf([object[]]$nodeArgs, '--port')
if ($portIdx -ge 0 -and $nodeArgs.Count -gt $portIdx + 1) { $port = [int]$nodeArgs[$portIdx + 1] }
elseif ($env:CLAUDINEI_PORT) { $port = [int]$env:CLAUDINEI_PORT }

# Quem está na porta: nosso servidor, ou um estranho?
$owner = $null
foreach ($conn in @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
  $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
  if ($owner) { break }
}
if ($owner) {
  $isOurs = $owner.Name -eq 'node.exe' -and $owner.CommandLine -and $owner.CommandLine.Contains($entry)
  if (-not $isOurs) {
    Boot "porta $port ocupada por pid=$($owner.ProcessId) ($($owner.Name)) que nao e este claudinei — nada a fazer"
    exit 1
  }
  $healthy = $false
  try { $healthy = (Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 8).StatusCode -eq 200 } catch { $healthy = $false }
  if ($healthy -and -not $force) { exit 0 }   # já no ar: silêncio, é o caso comum das checagens periódicas
  # Ou está travado, ou é um restart explícito. Derruba: o Agendador mata só o
  # processo da tarefa, então uma instância órfã pode estar segurando porta e logs.
  Boot "derrubando instancia pid=$($owner.ProcessId) (saudavel=$healthy force=$force)"
  Stop-Process -Id $owner.ProcessId -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}

Boot "iniciando  $root  (janela do console ainda visivel apos hide: $janelaVisivel)"

# node pode não estar no PATH da sessão da tarefa; cai no caminho padrão da instalação
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { $node = "$env:ProgramFiles\nodejs\node.exe" }
if (-not (Test-Path $node)) { Boot 'ERRO: node.exe nao encontrado'; throw "node.exe não encontrado (nem no PATH nem em $node)" }

# idem para a CLI do Claude Code, que o backend spawna
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  if (Test-Path $claude) { $env:CLAUDINEI_CLAUDE_BIN = $claude }
}

# Guarda a execução anterior como .prev (best-effort: arquivo preso nunca pode
# impedir o servidor de subir).
foreach ($f in @($log, $errLog)) {
  if (Test-Path $f) {
    try { Move-Item $f "$f.prev" -Force } catch { Boot "aviso: nao consegui rotacionar $(Split-Path -Leaf $f): $($_.Exception.Message)" }
  }
}

# cmd.exe só existe aqui para o `>>` nos logs; o CreateNoWindow é quem garante
# "sem janela" e o console isolado. Aspas duplas externas envolvem a linha toda —
# exigência do `cmd /c` quando há vários caminhos entre aspas.
$quoted = ($nodeArgs | ForEach-Object { '"' + $_ + '"' }) -join ' '
$inner = '"' + $node + '" "' + $entry + '"'
if ($quoted) { $inner += ' ' + $quoted }
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'cmd.exe'
$psi.Arguments = '/c "' + $inner + ' >> "' + $log + '" 2>> "' + $errLog + '""'
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
$proc = [System.Diagnostics.Process]::Start($psi)
$proc.WaitForExit()
Boot "saiu com codigo $($proc.ExitCode)"
exit $proc.ExitCode
