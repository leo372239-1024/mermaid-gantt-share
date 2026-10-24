<#
    register-autostart.ps1 -- make the local stack start automatically at logon.

    WHY A SCHEDULED TASK (and not the Startup folder)
    -------------------------------------------------
    The first version of this project relied on
        %APPDATA%\...\Startup\MermaidGanttAutoStart.vbs
    plus the containers' `restart: unless-stopped`. On 2026-10-15 both layers
    were found to have failed silently:

      * the containers had been stopped manually on 2026-10-14 00:02, and
        `unless-stopped` deliberately does NOT resurrect a manually stopped
        container after a daemon restart (docker-compose.yml now uses `always`);
      * the Startup-folder VBS *did* run, but ~3.5 min after the shell came up,
        and it never produced a single `docker` call -- Huorong (火绒) HIPS logs
        the entry as `fp_name_touch_startup_malware` (class `file_prot_v6`,
        risk 3), i.e. script autostart from the Startup folder is exactly the
        pattern its startup-item protection watches.

    A Task Scheduler task launched by cmd.exe avoids Windows Script Host and the
    Startup folder entirely, runs on a defined trigger, and can be inspected and
    re-run with one command.

    Register (no admin rights needed):
        powershell -ExecutionPolicy Bypass -File tools\register-autostart.ps1

    Inspect:
        Get-ScheduledTask -TaskName MermaidGanttShare-Local

    Run it right now:
        Start-ScheduledTask -TaskName MermaidGanttShare-Local

    Remove:
        powershell -ExecutionPolicy Bypass -File tools\unregister-autostart.ps1
#>

$ErrorActionPreference = 'Stop'

$taskName  = 'MermaidGanttShare-Local'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$cmdPath   = Join-Path $scriptDir 'local-up.cmd'
$repoRoot  = Split-Path -Parent $scriptDir
$me        = $env:USERDOMAIN + '\' + $env:USERNAME

if (-not (Test-Path $cmdPath)) {
    throw "Launcher not found: $cmdPath"
}

$description = 'Start the Mermaid Gantt Share local stack (Docker + PostgreSQL) at logon. Runs tools\local-up.cmd, which waits for the Docker engine and then executes docker compose up -d. Log: logs\autostart.log'

$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument ('/c "' + $cmdPath + '"') -WorkingDirectory $repoRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn
$trigger.Delay = 'PT30S'

$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Limited

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description

$registered = $false
try {
    Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
    $registered = $true
} catch {
    Write-Host "Register (InputObject) failed: $($_.Exception.Message)"
    Write-Host 'Retrying with explicit parameters ...'
    try {
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description $description -Force | Out-Null
        $registered = $true
    } catch {
        Write-Host "Register (explicit) failed: $($_.Exception.Message)"
    }
}

if (-not $registered) {
    throw "Could not register scheduled task '$taskName'."
}

$check = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -eq $check) {
    throw "Task '$taskName' reports success but cannot be read back."
}

Write-Host ''
Write-Host "Registered scheduled task : $taskName"
Write-Host "  state                   : $($check.State)"
Write-Host "  trigger                 : at logon (+30 s delay)"
Write-Host "  command                 : cmd.exe /c `"$cmdPath`""
Write-Host "  working directory       : $repoRoot"
Write-Host "  log                     : $(Join-Path $repoRoot 'logs\autostart.log')"
Write-Host ''
Write-Host ('Verify : Get-ScheduledTask -TaskName ' + $taskName)
Write-Host ('Run now: Start-ScheduledTask -TaskName ' + $taskName)
Write-Host 'Remove : powershell -ExecutionPolicy Bypass -File tools\unregister-autostart.ps1'
Write-Host ''
