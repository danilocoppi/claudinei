# Registra (ou remove) o Claudinei no autostart do Windows via Agendador de Tarefas.
# Roda no logon do usuário atual, sem janela, com reinício automático se cair.
# Não precisa de administrador — a tarefa é do usuário, com o PATH/HOME dele
# (onde vivem o `claude` e o ~/.claudinei).
#
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\windows\install-autostart.ps1 -Uninstall
[CmdletBinding()]
param(
  [string]$TaskName = 'Claudinei',
  [switch]$Uninstall,
  [switch]$NoStart,           # registra sem iniciar agora
  [string[]]$ExtraArgs = @(), # ex.: --port 9200
  [int]$WatchdogMinutes = 2   # de quanto em quanto tempo checar se o servidor caiu
)
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "tarefa '$TaskName' removida"
}
if ($Uninstall) { return }

$launcher = Join-Path $PSScriptRoot 'start-claudinei.ps1'
if (-not (Test-Path $launcher)) { throw "launcher não encontrado: $launcher" }

$psArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$launcher`""
if ($ExtraArgs.Count -gt 0) { $psArgs += ' ' + ($ExtraArgs -join ' ') }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $psArgs `
  -WorkingDirectory (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))

# Dois gatilhos: o logon sobe o serviço; o periódico é o vigia. Com
# MultipleInstances=IgnoreNew, enquanto a tarefa está rodando (servidor no ar) o
# gatilho periódico é simplesmente ignorado — ele só chega a executar se a tarefa
# tiver terminado, e aí o launcher checa a saúde e ressuscita o que precisar.
$logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$logon.Delay = 'PT20S'   # deixa a rede/PATH assentarem antes de subir
# Sem -RepetitionDuration de propósito: duração vazia é "repetir indefinidamente"
# (TimeSpan::MaxValue vira P99999999DT23H59M59S e o Agendador rejeita o XML).
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).Date `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes)
$trigger = @($logon, $watchdog)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" `
  -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -Hidden
$settings.DisallowStartOnRemoteAppSession = $false
$settings.MultipleInstances = 'IgnoreNew'   # já está rodando? não sobe uma segunda

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings `
  -Description 'Claudinei — interface web local para sessões do Claude Code (http://127.0.0.1:9105)' | Out-Null
Write-Host "tarefa '$TaskName' registrada (logon de $env:USERNAME, sem janela, vigia a cada $WatchdogMinutes min)"

if (-not $NoStart) {
  Start-ScheduledTask -TaskName $TaskName
  Write-Host 'iniciada — http://127.0.0.1:9105'
}
