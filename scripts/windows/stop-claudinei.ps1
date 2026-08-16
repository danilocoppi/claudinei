# Para o Claudinei de verdade: encerra a tarefa agendada e o servidor que ela deixou
# para trás (o Agendador mata só o processo da tarefa; o node filho fica órfão).
# Só derruba node.exe rodando o bin/claudinei.mjs DESTE repo — um `npm run dev` de
# outro clone, ou qualquer outro processo na porta, fica intocado.
[CmdletBinding()]
param([string]$TaskName = 'Claudinei')
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$entry = Join-Path $root 'bin\claudinei.mjs'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Write-Host "tarefa '$TaskName' encerrada"
}

$killed = 0
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue)) {
  if ($p.CommandLine -and $p.CommandLine.Contains($entry)) {
    Write-Host "encerrando servidor pid=$($p.ProcessId)"
    Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
}
if ($killed -eq 0) { Write-Host 'nenhum servidor deste repo estava rodando' }
