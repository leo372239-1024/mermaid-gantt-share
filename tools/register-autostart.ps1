<#
    register-autostart.ps1 -- make the local stack start automatically at logon.

    Docker Desktop already has "start at sign-in" enabled on this machine, and both
    containers use `restart: unless-stopped`, so they come back by themselves.
    This scheduled task is a belt-and-braces fallback: it waits for the Docker
    engine and then runs `docker compose up -d`, covering the case where Docker
    Desktop was slow, was quit manually, or the containers were stopped with
    `docker compose down`.

    Register (no admin rights needed):
        powershell -ExecutionPolicy Bypass -File tools\register-autostart.ps1

    Inspect:
        schtasks /Query /TN "MermaidGanttShare-Local"

    Run it right now:
        schtasks /Run /TN "MermaidGanttShare-Local"

    Remove:
        schtasks /Delete /TN "MermaidGanttShare-Local" /F
#>

$ErrorActionPreference = 'Stop'

$taskName  = 'MermaidGanttShare-Local'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdPath   = Join-Path $scriptDir 'local-up.cmd'

if (-not (Test-Path $cmdPath)) {
    throw "Launcher not found: $cmdPath"
}

$action = 'cmd.exe /c "' + $cmdPath + '"'

# /SC ONLOGON fires at every sign-in; /F overwrites an existing definition.
schtasks /Create /TN $taskName /TR $action /SC ONLOGON /F | Out-Null

Write-Host ''
Write-Host "Registered scheduled task : $taskName"
Write-Host "  trigger                 : at logon"
Write-Host "  command                 : $action"
Write-Host ''
Write-Host 'Verify : schtasks /Query /TN "' + $taskName + '"'
Write-Host 'Run now: schtasks /Run   /TN "' + $taskName + '"'
Write-Host 'Remove : schtasks /Delete /TN "' + $taskName + '" /F'
Write-Host ''
