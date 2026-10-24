<#
    unregister-autostart.ps1 -- remove the logon auto-start task.

    The running stack is left untouched; only the trigger is removed.

        powershell -ExecutionPolicy Bypass -File tools\unregister-autostart.ps1
#>

$ErrorActionPreference = 'Stop'

$taskName = 'MermaidGanttShare-Local'

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $existing) {
    Write-Host "Nothing to remove - task '$taskName' is not registered."
} else {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task : $taskName"
}

$vbs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\MermaidGanttAutoStart.vbs'
if (Test-Path $vbs) {
    Remove-Item -LiteralPath $vbs -Force
    Write-Host "Removed startup entry  : $vbs"
}
