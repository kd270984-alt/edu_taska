# ВЫКЛЮЧИТЬ КОПИЮ ТАСКИ НА ЭТОМ КОМПЬЮТЕРЕ (Windows) — одна команда в PowerShell:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.taska-backup\uninstall-windows.ps1"
# Убирает задачу из Планировщика, скрипты и обе отметки на сервере (иначе ночной отчёт каждый день писал бы
# «ноутбук не забирал копию»). Сами копии — папку TaskaBackup — НЕ трогает.
$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = (New-Object System.Text.UTF8Encoding $false) } catch {}
$HostName = if ($env:TASKA_HOST) { $env:TASKA_HOST } else { 'taska' }
$Remote = if ($env:TASKA_REMOTE_DIR) { $env:TASKA_REMOTE_DIR } else { '/root/taska-edu' }
$Dest = if ($env:TASKA_BACKUP_DIR) { $env:TASKA_BACKUP_DIR } else { Join-Path $env:USERPROFILE 'TaskaBackup' }
$App = if ($env:TASKA_APP_DIR) { $env:TASKA_APP_DIR } else { Join-Path $env:USERPROFILE '.taska-backup' }
$TaskName = if ($env:TASKA_TASK_NAME) { $env:TASKA_TASK_NAME } else { 'TaskaBackup' }

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $Dest '.state\lock') -Recurse -Force -ErrorAction SilentlyContinue

$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"; if (-not (Test-Path -LiteralPath $ssh)) { $ssh = 'ssh' }
$cfg = if ($env:TASKA_SSH_CONFIG) { "-F `"$($env:TASKA_SSH_CONFIG)`" " } else { '' }
$p = Start-Process -FilePath $ssh -ArgumentList "$cfg-n -o BatchMode=yes -o ConnectTimeout=10 $HostName rm -f $Remote/backups/.laptop-ok $Remote/backups/.laptop-files-ok" -NoNewWindow -Wait -PassThru -RedirectStandardError (Join-Path ([IO.Path]::GetTempPath()) 'taska-uninstall-err.txt')
if ($p.ExitCode -eq 0) { $note = 'отметки на сервере убрал' }
else { $note = 'сервер не ответил — отметки backups/.laptop-ok и backups/.laptop-files-ok на нём уберите потом сами (иначе ночной отчёт будет напоминать про ноутбук)' }
$still = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($still) { [Console]::Out.WriteLine("НЕ ВЫКЛЮЧЕНО: задача $TaskName осталась в Планировщике — удалите её там вручную."); exit 1 }
[Console]::Out.WriteLine("Копия Таски на этом компьютере выключена: задачи и скриптов больше нет, $note.")
[Console]::Out.WriteLine("Сами копии остались в папке $Dest — удалите её, если они не нужны.")
exit 0
