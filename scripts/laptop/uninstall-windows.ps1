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

# Идущий запуск копии (проверка на Windows 12.11.2026): Планировщик останавливает только корневой процесс задачи
# (conhost --headless или powershell), а остальное — powershell с taska-backup.ps1, его ssh/scp/sftp — продолжает
# работать. Поэтому гасим САМИ и ДО остановки задачи, пока дерево процессов цело: powershell с нашим скриптом из
# этой папки (и запуск из блокировки) — вместе с дочерними; scp, пишущий в папку копий, — тоже. Предков текущего
# процесса (оболочку, из которой запустили установщик) не трогаем. Нет WMI — только процесс из блокировки, если это
# PowerShell, запущенный не позже блокировки. Недокачанные копии базы (.part-*) остановленных запусков — убираем.
function Stop-Running([string]$AppDir, [string]$DestDir) {
  $lockPid = 0; $lockAt = [int64]0
  try {
    $parts = ([IO.File]::ReadAllText((Join-Path $DestDir '.state\lock\info'))).Trim() -split ' '
    if ($parts[0] -match '^\d+$') { $lockPid = [int]$parts[0] }
    if ($parts.Count -gt 1 -and $parts[1] -match '^\d+$') { $lockAt = [int64]$parts[1] }
  } catch {}
  $procs = $null
  try { $procs = @(Get-CimInstance Win32_Process -ErrorAction Stop) } catch {}
  $app = $AppDir.TrimEnd('\').ToLowerInvariant(); $dst = $DestDir.TrimEnd('\').ToLowerInvariant()
  $ids = New-Object System.Collections.Generic.List[int]
  if ($procs) {
    $mine = @{}; $cur = $PID
    for ($i = 0; $i -lt 32 -and $cur; $i++) {
      $mine[[int]$cur] = $true
      $pp = $procs | Where-Object { $_.ProcessId -eq $cur } | Select-Object -First 1
      if (-not $pp) { break }; $cur = [int]$pp.ParentProcessId
    }
    foreach ($p in $procs) {
      $id = [int]$p.ProcessId
      if ($mine.ContainsKey($id)) { continue }
      $cl = ([string]$p.CommandLine).ToLowerInvariant(); if (-not $cl) { continue }
      $n = ([string]$p.Name).ToLowerInvariant()
      $ours = $cl -match 'taska-backup\.ps1|test-run\.ps1'
      if ($n -in @('powershell.exe', 'pwsh.exe') -and $ours -and ($cl.Contains($app) -or $id -eq $lockPid)) { $ids.Add($id) }
      elseif ($n -eq 'scp.exe' -and ($cl.Contains($dst) -or $cl -match '/backups/\d{4}-\d{2}-\d{2}\.sql\.gz"?\s+"?\.part-\d+\.sql\.gz')) { $ids.Add($id) }   # сирота: копия базы (путь относительный)
      elseif ($n -eq 'sftp.exe' -and $cl -match '(^|\s)-b\s+"?batch\.txt') { $ids.Add($id) }   # сирота: докачка файлов задач
    }
  } elseif ($lockPid -and $lockPid -ne $PID) {
    $gp = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
    if ($gp -and $gp.ProcessName -in @('powershell', 'pwsh')) {
      try { if ($lockAt -and ([DateTimeOffset]$gp.StartTime).ToUnixTimeSeconds() -le $lockAt + 5) { $ids.Add($lockPid) } } catch {}
    }
  }
  $killed = 0
  foreach ($id in ($ids | Select-Object -Unique)) { & "$env:WINDIR\System32\taskkill.exe" /PID $id /T /F 2>&1 | Out-Null; $killed++ }
  if ($killed) { Start-Sleep -Milliseconds 700 }
  # файл может держаться ещё мгновение после остановки scp — пробуем до 3 с
  for ($i = 0; $i -lt 6; $i++) {
    $left = @(Get-ChildItem -LiteralPath $DestDir -Force -Filter '.part-*.sql.gz' -ErrorAction SilentlyContinue)
    if (-not $left) { break }
    $left | Remove-Item -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500
  }
  return $killed
}

# идущий запуск — до остановки задачи и до уборки, иначе он вернёт отметки на сервер
[void](Stop-Running $App $Dest)
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
}
[void](Stop-Running $App $Dest)   # на случай, если задача успела стартовать между проверками
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
