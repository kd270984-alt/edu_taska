# УСТАНОВЩИК КОПИИ ТАСКИ НА НОУТБУК (Windows). Его запускает помощник по промпту «Копия на ноутбук»,
# в PowerShell:
#   cd $env:TEMP
#   scp taska:/root/taska-edu/scripts/laptop/install-windows.ps1 .
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install-windows.ps1
# Забирает с сервера остальные скрипты, делает первую копию, ставит задачу в Планировщик и проверяет её.
# Повторный запуск безопасен — так же копия и обновляется (сами копии и их учёт не трогает).
# Права администратора НЕ нужны: задача ставится на текущего пользователя.
#
#   -Window visible  — запасной путь, если скрытый запуск запрещён (рабочий ноутбук, антивирус):
#                      окно PowerShell будет мелькать свёрнутым раз в час.
#
# Замечания критика 11.11.2026, учтённые здесь:
#   - сначала первая копия напрямую (её вывод видит помощник), потом задача; у копии своя блокировка;
#   - первый запуск задачи — в ближайший БУДУЩИЙ час, а не «сегодня в 9:00» (прошедшее время вместе
#     с «как можно скорее» запускало задачу прямо при регистрации, вторым экземпляром);
#   - Start-ScheduledTask асинхронный: ждём отметку её запуска (не дольше 60 с); весь установщик
#     укладывается в 90 с — у помощника тайм-аут на команду. Если на медленной связи время кончилось
#     раньше проверки — код 4 «поставлено, но не проверено», а не ложное «НЕ УСТАНОВЛЕНО» (критик 12.11);
#   - предел задачи 4 ч (у sftp внутри — 3 ч), а оборванная докачка не теряется: см. taska-backup.ps1;
#   - от батареи задача запускается (по умолчанию Windows её бы не запускала никогда);
#   - установщик работает только от того, кто сейчас за компьютером (песочница помощника может
#     запустить его от другой учётки — тогда задача встала бы не тому человеку).
param([ValidateSet('hidden', 'visible')][string]$Window = 'hidden')
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$Utf8 = New-Object System.Text.UTF8Encoding $false
try { [Console]::OutputEncoding = $Utf8 } catch {}
$T0 = Get-Date

$HostName = if ($env:TASKA_HOST) { $env:TASKA_HOST } else { 'taska' }
$Remote = if ($env:TASKA_REMOTE_DIR) { $env:TASKA_REMOTE_DIR } else { '/root/taska-edu' }
$Dest = if ($env:TASKA_BACKUP_DIR) { $env:TASKA_BACKUP_DIR } else { Join-Path $env:USERPROFILE 'TaskaBackup' }
$App = if ($env:TASKA_APP_DIR) { $env:TASKA_APP_DIR } else { Join-Path $env:USERPROFILE '.taska-backup' }
$TaskName = if ($env:TASKA_TASK_NAME) { $env:TASKA_TASK_NAME } else { 'TaskaBackup' }
$SshOpts = '-o BatchMode=yes -o ConnectTimeout=15'
if ($env:TASKA_SSH_CONFIG) { $SshOpts = "-F `"$($env:TASKA_SSH_CONFIG)`" $SshOpts" }

function Say([string]$m) { [Console]::Out.WriteLine("• $m") }
function Stop-Install([string]$m) { [Console]::Out.WriteLine(''); [Console]::Out.WriteLine("НЕ УСТАНОВЛЕНО: $m"); exit 1 }

function Tool([string]$name) {
  foreach ($d in @("$env:WINDIR\System32\OpenSSH", "$env:WINDIR\Sysnative\OpenSSH")) {
    if ($env:WINDIR -and (Test-Path -LiteralPath "$d\$name.exe")) { return "$d\$name.exe" }
  }
  $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}
function Run([string]$exe, [string]$argline, [string]$cwd = $null, [int]$timeout = 60) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $exe; $psi.Arguments = $argline
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.RedirectStandardInput = $true
  $psi.StandardOutputEncoding = $Utf8; $psi.StandardErrorEncoding = $Utf8
  if ($cwd) { $psi.WorkingDirectory = $cwd }
  try { $p = [System.Diagnostics.Process]::Start($psi) } catch { return @{ Code = 127; Out = ''; Err = "$_" } }
  $p.StandardInput.Close()
  $o = $p.StandardOutput.ReadToEndAsync(); $e = $p.StandardError.ReadToEndAsync()
  if (-not $p.WaitForExit($timeout * 1000)) {
    # всем деревом: иначе scp, запущенный первой копией, остался бы качать сиротой
    & "$env:WINDIR\System32\taskkill.exe" /PID $p.Id /T /F 2>&1 | Out-Null
    try { $p.Kill() } catch {}; $p.WaitForExit() | Out-Null; return @{ Code = 255; Out = $o.Result; Err = 'Connection timed out (killed)' }
  }
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = $o.Result; Err = $e.Result }
}

[Console]::Out.WriteLine('Ставлю копию Таски на этот компьютер…')
if ($env:OS -ne 'Windows_NT') { Stop-Install 'этот установщик — для Windows. На Mac — install-mac.sh. Linux и WSL не поддерживаются: держите копию вручную (промпт «Скачать копию вручную» в памятке).' }
if ($PSVersionTable.PSVersion.Major -lt 5) { Stop-Install 'нужен Windows PowerShell 5.1 или новее (Windows 10 и 11 — уже с ним).' }
$Ssh = Tool 'ssh'; $Scp = Tool 'scp'; $Sftp = Tool 'sftp'
if (-not $Ssh -or -not $Scp -or -not $Sftp) { Stop-Install 'в Windows не нашёлся клиент OpenSSH. Включите его: Параметры → Приложения → Дополнительные компоненты → «Клиент OpenSSH», и повторите.' }
if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) { Stop-Install 'в этой Windows нет Планировщика заданий для PowerShell (нужна Windows 10 или 11).' }

# тот ли пользователь: владелец рабочего стола (explorer.exe) = тот, кто запустил установщик
$Me = [Security.Principal.WindowsIdentity]::GetCurrent()
$MySid = $Me.User.Value
try {
  $owners = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'" -ErrorAction Stop | ForEach-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid } | Where-Object { $_ })
  if ($owners.Count -gt 0 -and $owners -notcontains $MySid) {
    Stop-Install "запущено не от того пользователя, кто сейчас за компьютером ($($Me.Name)). Помощник, похоже, работает в песочнице — разрешите ему выполнить установщик вне песочницы и повторите."
  }
} catch {}

# ---------- сервер: вход, скрипты, копии. Ошибки ssh разбираем по тексту ----------
function No-Alias {
  if ($HostName -match '[.:]') { return $false }
  $r = Run $Ssh "-G $SshOpts $HostName" $null 20
  foreach ($l in ($r.Out -split "`n")) { if ($l.Trim() -eq "hostname $HostName") { return $true } }
  return $false
}
function RCheck([string]$cmd) {   # две попытки, только если обрыв связи
  for ($i = 1; $i -le 2; $i++) {
    $r = Run $Ssh "-n $SshOpts $HostName $cmd" $null 30
    if ($r.Code -eq 0) { return $r }
    $e = $r.Err
    if ($e -match "Could not resolve hostname $([regex]::Escape($HostName)):" -or ($r.Code -eq 255 -and (No-Alias))) {
      Stop-Install "на этом компьютере нет входа «ssh $HostName». Сначала шаг «Подключить помощника» из памятки, потом этот промпт ещё раз."
    }
    if ($e -match 'Permission denied \(|Too many authentication failures|no such identity|UNPROTECTED PRIVATE KEY|Load key') {
      Stop-Install 'ключ этого компьютера не подходит к серверу (так бывает, если «Подключить помощника» нажали на другом компьютере — это отключает ключ этого). Пройдите на этом компьютере шаг «Подключить помощника» и повторите.'
    }
    if ($e -match 'IDENTIFICATION HAS CHANGED|Host key verification failed') { Stop-Install 'сервер переустановлен или заменён. Пройдите шаг «Подключить помощника» и повторите.' }
    if ($r.Code -ne 255) { return $r }   # сервер ответил, но команда не вышла
    if ($i -eq 1) { Start-Sleep -Seconds 5 }
  }
  Stop-Install 'нет связи с сервером. Проверьте интернет; рабочий Wi-Fi иногда закрывает вход на серверы — попробуйте другую сеть и повторите.'
}
$r = RCheck "ls -1 $Remote/scripts/laptop"
if ($r.Code -ne 0) { Stop-Install 'на сервере нет папки scripts/laptop — сначала обновите скрипты Таски на сервере (пункт 1 этого промпта).' }
if (($r.Out -split "`n" | ForEach-Object { $_.Trim() }) -notcontains 'taska-backup.ps1') { Stop-Install 'на сервере неполная папка scripts/laptop — обновите скрипты Таски на сервере (пункт 1 этого промпта).' }
$r = RCheck "ls -1 $Remote/backups"
if (-not ($r.Out -split "`n" | Where-Object { $_.Trim() -match '^\d{4}-\d{2}-\d{2}\.sql\.gz$' })) {
  Stop-Install 'на сервере нет ни одной ночной копии. Сначала промпт 1 этого шага (ночная копия на сервере), потом этот ещё раз.'
}
Say 'сервер на связи, ночные копии на нём есть'

try { $free = (New-Object IO.DriveInfo ([IO.Path]::GetPathRoot($env:USERPROFILE))).AvailableFreeSpace } catch { $free = 2GB }
if ($free -lt 1GB) { Stop-Install 'на этом компьютере свободно меньше 1 ГБ — освободите место и повторите.' }

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
      elseif ($n -eq 'sftp.exe' -and $cl -match '(^|\s)-b\s+"?batch\.txt' -and $cl -match ('\s"?' + [regex]::Escape($HostName.ToLowerInvariant()) + '"?\s*$')) { $ids.Add($id) }   # сирота: докачка файлов задач с нашего сервера
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

# ---------- скрипты с сервера (во временную папку: короткие латинские имена, русский путь — только рабочей папкой) ----------
$tmp = Join-Path ([IO.Path]::GetTempPath()) ("taska-install-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$r = Run $Scp "-q -r $SshOpts ${HostName}:$Remote/scripts/laptop laptop" $tmp 60
if ($r.Code -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $tmp 'laptop\taska-backup.ps1'))) {
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Stop-Install "не скачались скрипты с сервера. $(($r.Err -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1))"
}
# старая задача — остановить ДО первой копии, чтобы не было двух запусков сразу; идущий запуск — тоже
$stopped = Stop-Running $App $Dest   # до остановки задачи, пока дерево процессов цело
$old = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($old) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue; Disable-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Out-Null }
$stopped += Stop-Running $App $Dest
if ($stopped -gt 0) { Say 'остановил идущую копию — новая установка сделает её заново' }
try {
  New-Item -ItemType Directory -Force -Path $App, (Join-Path $Dest '.state') -ErrorAction Stop | Out-Null
  Copy-Item -Path (Join-Path $tmp 'laptop\*') -Destination $App -Force -ErrorAction Stop
} catch { Stop-Install "не смог записать скрипты в $App" } finally { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
$inst = Join-Path $Dest '.state\installed'
if (-not (Test-Path -LiteralPath $inst)) { [IO.File]::WriteAllText($inst, "$([DateTimeOffset]::Now.ToUnixTimeSeconds())`n", $Utf8) }
$ver = (Get-Content -LiteralPath (Join-Path $App 'VERSION') -TotalCount 1).Trim()
Say "скрипты версии $ver — в $App"

# ---------- первая копия: напрямую, чтобы помощник видел, что вышло ----------
$Script = Join-Path $App 'taska-backup.ps1'
# всегда Windows PowerShell 5.1 (даже если установщик запустили из PowerShell 7)
$Ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'; if (-not (Test-Path -LiteralPath $Ps)) { $Ps = 'powershell.exe' }
Say 'первая копия базы:'
# Предел первой копии — из того, что осталось от 90 с (на медленной связи проверки выше могли занять
# своё), с запасом ~15 с на постановку задачи. Не уложилась — задачу всё равно ставим: копию сделает она.
$left = [int](75 - ((Get-Date) - $T0).TotalSeconds); if ($left -lt 20) { $left = 20 }
$first = Run $Ps "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Script`" -Now" $null $left
foreach ($l in ($first.Out -split "`n" | Where-Object { $_.Trim() })) { [Console]::Out.WriteLine("    $($l.TrimEnd())") }
$FirstCode = $first.Code

# ---------- задача: каждый час с ближайшего часа, при входе; после сна и выключения — как можно скорее ----------
function X([string]$s) { return [Security.SecurityElement]::Escape($s) }
$start = (Get-Date).Date.AddHours((Get-Date).Hour + 1).ToString("yyyy-MM-dd'T'HH:mm:ss")   # ближайший БУДУЩИЙ час
$psArgs = "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Script`""
$conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
# установщик запущен из 32-битного PowerShell: System32 для него подменяется на SysWOW64, где conhost нет, —
# проверяем настоящую System32 через Sysnative, а в задачу пишем обычный путь (проверка на Windows 12.11.2026)
$probe = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) { Join-Path $env:WINDIR 'Sysnative\conhost.exe' } else { $conhost }
if ($Window -eq 'hidden' -and -not (Test-Path -LiteralPath $probe)) { Say 'скрытый запуск недоступен на этой Windows — копия будет идти в свёрнутом окне' }
if ($Window -eq 'hidden' -and (Test-Path -LiteralPath $probe)) {
  # Windows 11: терминал по умолчанию — Windows Terminal, и -WindowStyle Hidden его не прячет;
  # conhost --headless запускает PowerShell вовсе без окна.
  $cmd = $conhost; $cmdArgs = "--headless `"$Ps`" $psArgs"
} else { $cmd = $Ps; $cmdArgs = ($psArgs -replace '-WindowStyle Hidden', '-WindowStyle Minimized') }
$envNote = ''
foreach ($v in 'TASKA_HOST', 'TASKA_REMOTE_DIR', 'TASKA_BACKUP_DIR', 'TASKA_SSH_CONFIG') {   # только для проверок; у учеников пусто
  if ((Get-Item "env:$v" -ErrorAction SilentlyContinue).Value) { $envNote = 'тест' }
}
if ($envNote) {
  # переменные для проверок передаём через обёртку: у задачи Планировщика своих переменных окружения нет
  $sets = ''
  foreach ($v in 'TASKA_HOST', 'TASKA_REMOTE_DIR', 'TASKA_BACKUP_DIR', 'TASKA_SSH_CONFIG') {
    $val = (Get-Item "env:$v" -ErrorAction SilentlyContinue).Value
    if ($val) { $sets += "`$env:$v = '$($val -replace "'", "''")'; " }
  }
  $wrap = Join-Path $App 'test-run.ps1'
  [IO.File]::WriteAllText($wrap, "$sets& '$($Script -replace "'", "''")'`r`nexit `$LASTEXITCODE`r`n", (New-Object System.Text.UTF8Encoding $true))
  $cmdArgs = $cmdArgs.Replace("`"$Script`"", "`"$wrap`"")
}
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Копия Таски на этот компьютер: раз в час проверяет сервер и забирает свежую копию. Выключить: uninstall-windows.ps1 в папке .taska-backup.</Description></RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>$start</StartBoundary>
      <Repetition><Interval>PT1H</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>
      <Enabled>true</Enabled>
    </TimeTrigger>
    <LogonTrigger><UserId>$(X $Me.Name)</UserId><Delay>PT2M</Delay><Enabled>true</Enabled></LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author"><UserId>$(X $MySid)</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <WakeToRun>false</WakeToRun>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT4H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec><Command>$(X $cmd)</Command><Arguments>$(X $cmdArgs)</Arguments></Exec>
  </Actions>
</Task>
"@
try { Register-ScheduledTask -TaskName $TaskName -Xml $xml -Force -ErrorAction Stop | Out-Null }
catch { Stop-Install "Windows не принял задачу в Планировщик: $($_.Exception.Message). На рабочих ноутбуках это иногда запрещено — тогда держите копию вручную (промпт «Скачать копию вручную» в памятке)." }

# проверка: запускаем задачу и ждём её отметку о запуске (не дольше 60 с и в пределах 90 с на всё).
# Конца не ждём: первая сверка файлов задач может идти долго, она докачивается в фоне.
# длина журнала ДО запуска задачи: первая копия к этому времени уже закончилась, и всё, что допишется, — от задачи
$Journal = Join-Path $Dest 'журнал.txt'
$jlen0 = $(try { (Get-Item -LiteralPath $Journal -ErrorAction Stop).Length } catch { -1 })
$T1 = [DateTimeOffset]::Now.ToUnixTimeSeconds()
Start-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
$ok = $false; $sched = Join-Path $Dest '.state\last_sched'
while ((([DateTimeOffset]::Now.ToUnixTimeSeconds()) - $T1) -lt 60 -and ((Get-Date) - $T0).TotalSeconds -lt 85) {
  Start-Sleep -Seconds 2
  $s = 0; try { $s = [int64](([IO.File]::ReadAllText($sched)) -replace '[^0-9]', '') } catch {}
  if ($s -ge $T1) { $ok = $true; break }
}
if (-not $ok -and ([DateTimeOffset]::Now.ToUnixTimeSeconds() - $T1) -lt 55) {
  # Не «не установлено»: задача стоит, просто на медленной связи 90 с кончились раньше, чем мы
  # дождались её запуска (замечание критика 12.11.2026). Отдельный код 4 — помощнику НЕ надо чинить.
  [Console]::Out.WriteLine('')
  [Console]::Out.WriteLine("ПОСТАВЛЕНО, НО НЕ ПРОВЕРЕНО: задача $TaskName в Планировщике стоит, а проверить её первый запуск не хватило времени (медленная связь). Ничего не чините: через 5 минут откройте $Dest\Последняя копия.txt — там должна быть свежая «Последняя проверка».")
  exit 4
}
if (-not $ok) {
  # Решаем сами, а не ученик по журналу: запустилась ли задача — вырос ли журнал после Start-ScheduledTask.
  # По времени строк нельзя: строки первой копии ложатся в ту же секунду (проверка на Windows 12.11.2026).
  $ran = ($(try { (Get-Item -LiteralPath $Journal -ErrorAction Stop).Length } catch { -1 }) -ne $jlen0)
  if ($ran) { Stop-Install "задача запустилась, но не дошла до конца за минуту. Откройте $Dest\журнал.txt и «Последняя копия.txt» из той же папки и покажите помощнику последние строки." }
  # Совет «-Window visible» — только тем, у кого его ещё не было: с ним этот же отказ значит, что дело
  # не в скрытом окне, и повторять установку бесполезно (проверка 16.11).
  if ($Window -eq 'hidden') { Stop-Install "задача поставлена, но Windows её не запустила — похоже, её не пускает антивирус или политика рабочего компьютера. Повторите установку с -Window visible (README, «Поставить»); не поможет — держите копию вручную (README, «Скачать копию вручную»)." }
  Stop-Install "задача поставлена, но Windows её не запустила даже в видимом окне (-Window visible) — её не пускает антивирус или политика рабочего компьютера, повторная установка не поможет. Держите копию вручную: раз в неделю промпт «Скачать копию вручную» из памятки (README, «Скачать копию вручную»). Неработающую задачу уберите: powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$App\uninstall-windows.ps1`""
}
Say 'задача в Планировщике стоит и сработала: каждый час, при входе в Windows и сразу после сна'

# ---------- итог ----------
$newest = Get-ChildItem -LiteralPath $Dest -File | Where-Object { $_.Name -match '^taska-\d{4}-\d{2}-\d{2}\.sql\.gz$' } | Sort-Object Name | Select-Object -Last 1
[Console]::Out.WriteLine('')
[Console]::Out.WriteLine("Готово. Папка с копиями: $Dest")
if ($newest) { [Console]::Out.WriteLine("Свежая копия базы: $($newest.Name) ($([math]::Ceiling($newest.Length / 1024)) КБ). Файлы задач докачиваются в фоне.") }
[Console]::Out.WriteLine("Установка заняла $([int]((Get-Date) - $T0).TotalSeconds) с.")
if ($env:TASKA_NO_OPEN -ne '1') { Start-Process explorer.exe -ArgumentList "`"$Dest`"" -ErrorAction SilentlyContinue }
if ($FirstCode -ne 0) {
  $first1 = ''
  try { $first1 = (Get-Content -LiteralPath (Join-Path $Dest 'Последняя копия.txt') -Encoding UTF8 -TotalCount 1) -replace '^ВНИМАНИЕ: ', '' } catch {}
  if ($first.Code -eq 255 -and $first.Err -match 'killed') { $first1 = 'не уложилась во время установки (медленная связь) — её доделает задача в Планировщике в течение часа.' }
  [Console]::Out.WriteLine('')
  [Console]::Out.WriteLine("НО ПЕРВАЯ КОПИЯ НЕ ВЫШЛА: $first1")
  exit 2
}
exit 0
