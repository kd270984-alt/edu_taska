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

# Идущий запуск копии (проверка на Windows 12.11.2026): Планировщик останавливает только conhost --headless, а
# powershell с taska-backup.ps1 и его ssh/scp/sftp продолжают работать. Находим их по записи блокировки и по
# командной строке (только наши скрипты из этой папки) и гасим вместе с дочерними процессами.
function Stop-Running([string]$AppDir, [string]$DestDir) {
  $ids = New-Object System.Collections.Generic.List[int]
  try {
    $first = (([IO.File]::ReadAllText((Join-Path $DestDir '.state\lock\info'))).Trim() -split ' ')[0]
    if ($first -match '^\d+$') { $ids.Add([int]$first) }
  } catch {}
  $procs = @()
  try { $procs = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop) } catch {}
  $app = $AppDir.TrimEnd('\').ToLowerInvariant()
  foreach ($p in $procs) {
    $cl = [string]$p.CommandLine
    if ($p.ProcessId -ne $PID -and $cl -and $cl.ToLowerInvariant().Contains($app) -and $cl -match 'taska-backup\.ps1|test-run\.ps1') { $ids.Add([int]$p.ProcessId) }
  }
  $killed = 0
  foreach ($id in ($ids | Select-Object -Unique)) {
    if ($id -eq $PID) { continue }
    $p = $procs | Where-Object { $_.ProcessId -eq $id } | Select-Object -First 1
    if (-not $p -or [string]$p.CommandLine -notmatch 'taska-backup\.ps1|test-run\.ps1') { continue }   # PID из блокировки мог достаться чужому процессу
    & "$env:WINDIR\System32\taskkill.exe" /PID $id /T /F 2>&1 | Out-Null; $killed++
  }
  if ($killed) { Start-Sleep -Milliseconds 700 }
  return $killed
}

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
[void](Stop-Running $App $Dest)   # идущий запуск — до уборки, иначе он вернёт отметки на сервер
Remove-Item -LiteralPath $App -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath (Join-Path $Dest '.state\lock') -Recurse -Force -ErrorAction SilentlyContinue
# «сегодня отметка уже ставилась» — забываем: переустановка в тот же день поставит отметки на сервер заново
foreach ($n in 'mark_day', 'fmark_day') { Remove-Item -LiteralPath (Join-Path $Dest ".state\$n") -Force -ErrorAction SilentlyContinue }

$ssh = "$env:WINDIR\System32\OpenSSH\ssh.exe"; if (-not (Test-Path -LiteralPath $ssh)) { $ssh = 'ssh' }
$cfg = if ($env:TASKA_SSH_CONFIG) { "-F `"$($env:TASKA_SSH_CONFIG)`" " } else { '' }
$errFile = Join-Path ([IO.Path]::GetTempPath()) 'taska-uninstall-err.txt'
$p = Start-Process -FilePath $ssh -ArgumentList "$cfg-n -o BatchMode=yes -o ConnectTimeout=10 $HostName rm -f $Remote/backups/.laptop-ok $Remote/backups/.laptop-files-ok" -NoNewWindow -Wait -PassThru -RedirectStandardError $errFile
Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
if ($p.ExitCode -eq 0) { $note = 'отметки на сервере убрал' }
else { $note = 'сервер не ответил — отметки backups/.laptop-ok и backups/.laptop-files-ok на нём уберите потом сами (иначе ночной отчёт будет напоминать про ноутбук)' }
$still = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($still) { [Console]::Out.WriteLine("НЕ ВЫКЛЮЧЕНО: задача $TaskName осталась в Планировщике — удалите её там вручную."); exit 1 }
[Console]::Out.WriteLine("Копия Таски на этом компьютере выключена: задачи и скриптов больше нет, $note.")
[Console]::Out.WriteLine("Сами копии остались в папке $Dest — удалите её, если они не нужны.")
exit 0
