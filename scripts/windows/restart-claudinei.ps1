# Reinicia o Claudinei — é o que usar depois de um rebuild (`npm run build -w web`)
# ou de mexer no código do servidor. Para a instância no ar (inclusive uma órfã que
# o Agendador tenha deixado para trás) e sobe de novo pela tarefa.
[CmdletBinding()]
param([string]$TaskName = 'Claudinei', [int]$TimeoutSeconds = 40)
$ErrorActionPreference = 'Stop'

& (Join-Path $PSScriptRoot 'stop-claudinei.ps1') -TaskName $TaskName
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName

$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
  try {
    if ((Invoke-WebRequest 'http://127.0.0.1:9105/' -UseBasicParsing -TimeoutSec 5).StatusCode -eq 200) {
      Write-Host 'no ar: http://127.0.0.1:9105'
      exit 0
    }
  } catch { Start-Sleep -Seconds 2 }
}
Write-Warning "nao respondeu em ${TimeoutSeconds}s — veja $env:USERPROFILE\.claudinei\logs\"
exit 1
