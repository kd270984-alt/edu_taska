# КОПИЯ ТАСКИ НА НОУТБУК (Windows). Забирает с сервера свежую ночную копию базы и докачивает новые
# файлы задач. Ставит и обновляет — install-windows.ps1, выключает — uninstall-windows.ps1.
#
#   taska-backup.ps1        — обычный запуск: так его зовёт Планировщик каждый час и при входе
#   taska-backup.ps1 -Now   — сразу и без пропуска, только база (так зовёт установщик)
#
# Тот же порядок действий, что в taska-backup.sh для Mac (решения владельца 11.11.2026):
#   - база — свежий ночной дамп с сервера каждый день, на ноутбуке 30 копий;
#   - файлы задач — полная копия, но докачивается только новое; прямо с сервера, без архивов на нём;
#     удалённое на сервере у нас живёт ещё 30 дней;
#   - на сервер пишем только две отметки: backups/.laptop-ok (база забрана) и .laptop-files-ok (файлы
#     сверены); по ним ночной отчёт сервера пишет «ноутбук не забирал копию / файлы задач N дней» —
#     даже если ноутбук сломан или задачу выключили.
#
# ⚠️ Windows PowerShell 5.1:
#   - файл сохранён в UTF-8 С BOM, иначе на русской Windows русские строки превратятся в кракозябры;
#   - ssh/scp/sftp зовём через Process, а не через «&»: 5.1 портит аргументы с кавычками и превращает
#     любой вывод в stderr в ошибку; так же читаем stderr целиком, чтобы разобрать ошибку по тексту;
#   - путь с кириллицей (C:\Users\Иван\…) в аргументы scp НЕ передаём: рабочая папка + короткое имя;
#   - двоичные данные — только scp/sftp в файл, никогда через конвейер или «>»;
#   - текстовые файлы — UTF-8 с BOM (Блокнот на русской Windows иначе путает кодировку).
# ⚠️ Окно тревоги — отдельным процессом, без ожидания: открытое окно не держит запуск
#    (иначе при IgnoreNew Планировщик не начинал бы следующие).
param([switch]$Now)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'

$AppDir = $PSScriptRoot
$Version = '?'
try { $Version = (Get-Content -LiteralPath (Join-Path $AppDir 'VERSION') -TotalCount 1 -ErrorAction Stop).Trim() } catch {}
$HostName = if ($env:TASKA_HOST) { $env:TASKA_HOST } else { 'taska' }
$Remote = if ($env:TASKA_REMOTE_DIR) { $env:TASKA_REMOTE_DIR } else { '/root/taska-edu' }
$HomeDir = if ($env:USERPROFILE) { $env:USERPROFILE } else { $HOME }
$Dest = if ($env:TASKA_BACKUP_DIR) { $env:TASKA_BACKUP_DIR } else { Join-Path $HomeDir 'TaskaBackup' }
$StateDir = Join-Path $Dest '.state'
$FilesDir = Join-Path $Dest 'files'
$LogFile = Join-Path $Dest 'журнал.txt'
$StatusFile = Join-Path $Dest 'Последняя копия.txt'
$Keep = 30        # копий базы — по счёту, а не по возрасту: выключенный на месяц ноутбук старое не сотрёт
$GoneDays = 30    # файл удалили на сервере — у нас он живёт ещё столько дней
$Utf8Bom = New-Object System.Text.UTF8Encoding $true
$Utf8 = New-Object System.Text.UTF8Encoding $false
$Mode = if ($Now) { 'now' } else { 'sched' }
# Установщик ждёт нас не дольше 90 с (у помощника тайм-аут на команду) — 2 попытки за ~40 с.
# По расписанию спешить некуда: 3 попытки за ~3 минуты, дальше — следующий час.
if ($Now) { $CT = 15; $RetryDelays = @(5) } else { $CT = 20; $RetryDelays = @(30, 90) }
if ($env:TASKA_RETRY_DELAYS) { $RetryDelays = @($env:TASKA_RETRY_DELAYS -split ' ' | Where-Object { $_ } | ForEach-Object { [int]$_ }) }   # только для проверок

# установщик читает наш вывод как UTF-8
if ($Now) { try { [Console]::OutputEncoding = $Utf8 } catch {} }

$NowT = [DateTime]::Now
$NowS = [int64]([DateTimeOffset]::Now.ToUnixTimeSeconds())
$Today = $NowT.ToString('yyyy-MM-dd')

function Tool([string]$name) {
  # 64-битный OpenSSH из Windows; Sysnative — если нас вдруг запустили 32-битным PowerShell
  foreach ($d in @("$env:WINDIR\System32\OpenSSH", "$env:WINDIR\Sysnative\OpenSSH")) {
    if ($env:WINDIR -and (Test-Path -LiteralPath "$d\$name.exe")) { return "$d\$name.exe" }
  }
  $c = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { return $c.Source }
  return $null
}
$Ssh = Tool 'ssh'; $Scp = Tool 'scp'; $Sftp = Tool 'sftp'

$SshOpts = "-o BatchMode=yes -o ConnectTimeout=$CT -o ServerAliveInterval=15 -o ServerAliveCountMax=4"
if ($env:TASKA_SSH_CONFIG) { $SshOpts = "-F `"$($env:TASKA_SSH_CONFIG)`" $SshOpts" }

function Write-Text([string]$path, [string]$text) { [IO.File]::WriteAllText($path, $text, $Utf8Bom) }
function Read-Num([string]$name) {
  $p = Join-Path $StateDir $name
  if (-not (Test-Path -LiteralPath $p)) { return $null }
  $t = ([IO.File]::ReadAllText($p) -replace '[^0-9]', '')
  if ($t) { return [int64]$t } else { return $null }
}
function Read-Line([string]$name) {
  $p = Join-Path $StateDir $name
  if (Test-Path -LiteralPath $p) { return ([IO.File]::ReadAllText($p)).Trim() } else { return '' }
}
function Set-State([string]$name, [string]$value) { [IO.File]::WriteAllText((Join-Path $StateDir $name), "$value`n", $Utf8) }
function Log([string]$m) {
  $line = (Get-Date).ToString('dd.MM.yyyy HH:mm:ss') + ' ' + $m + "`r`n"
  try { [IO.File]::AppendAllText($LogFile, $line, $Utf8Bom) } catch {}
  # прямо в консоль, а не Write-Output: иначе строка журнала попала бы в результат функции
  if ($Now) { [Console]::Out.WriteLine($m) }
}
# «1 файл», «2 файла», «5 файлов»
function Files-Word([long]$n) {
  $m10 = $n % 10; $m100 = $n % 100
  if ($m10 -eq 1 -and $m100 -ne 11) { return 'файл' }
  if ($m10 -ge 2 -and $m10 -le 4 -and ($m100 -lt 12 -or $m100 -gt 14)) { return 'файла' }
  return 'файлов'
}
function HSize([double]$b) {
  if ($b -lt 1048576) { return ('{0} КБ' -f [math]::Floor(($b + 1023) / 1024)) }
  if ($b -lt 1073741824) { return (('{0:0.0} МБ' -f ($b / 1048576)) -replace '\.', ',') }
  return (('{0:0.0} ГБ' -f ($b / 1073741824)) -replace '\.', ',')
}
function FromUnix([int64]$s) { return [DateTimeOffset]::FromUnixTimeSeconds($s).LocalDateTime }
function DayOf([string]$d) { $p = $d.Split('-'); return "$($p[2]).$($p[1])" }   # 2026-11-12 → 12.11

try {
  New-Item -ItemType Directory -Force -Path $Dest, $StateDir -ErrorAction Stop | Out-Null
} catch { [Console]::Out.WriteLine("не могу создать папку $Dest"); exit 1 }

# ---------- блокировка: два запуска сразу писали бы один файл (установщик + Планировщик, вход + час) ----------
$LockDir = Join-Path $StateDir 'lock'
$Hung = 43200   # 12 часов: столько не идёт даже первая докачка большого хранилища на медленной связи
# Жив, это PowerShell и запущен не позже, чем взял блокировку: номер процесса мог достаться другому
# (после перезагрузки — например, окну PowerShell самого человека). Такую блокировку считаем брошенной,
# а не «зависшей», — иначе через 12 часов мы убили бы чужую программу.
function Ours([int]$id, [int64]$t) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($null -eq $p -or $p.ProcessName -notmatch '^(powershell|pwsh)$') { return $false }
  try { $st = ([DateTimeOffset]$p.StartTime).ToUnixTimeSeconds() } catch { return $false }
  return ($st -le $t + 5)
}
function Take-Lock {
  try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $LockDir 'info'), "$PID $NowS", $Utf8); return $true
  } catch {}
  $info = ''
  try { $info = [IO.File]::ReadAllText((Join-Path $LockDir 'info')) } catch {}
  $parts = $info.Trim() -split ' '
  if (-not $info.Trim()) {
    # хозяин только что создал папку и ещё не записал себя
    $age = ([DateTime]::Now - (Get-Item -LiteralPath $LockDir).LastWriteTime).TotalSeconds
    if ($age -lt 60) { return $false }
  } elseif (Ours ([int]$parts[0]) ([int64]$parts[1])) {
    # Живую копию НЕ перехватываем никогда (замечание критика 12.11.2026: перехват через 3 ч давал
    # два запуска в одной папке). Только явно зависшую дольше 12 ч — сначала убиваем вместе с sftp.
    if (([DateTimeOffset]::Now.ToUnixTimeSeconds() - [int64]$parts[1]) -lt $Hung) { return $false }
    Log "прошлый запуск (PID $($parts[0])) висит больше 12 часов — останавливаю его"
    & "$env:WINDIR\System32\taskkill.exe" /PID $parts[0] /T /F 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    if (Ours ([int]$parts[0]) ([int64]$parts[1])) { return $false }
  }
  # брошенная: процесс умер (или его остановили выше)
  Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue
  try {
    New-Item -ItemType Directory -Path $LockDir -ErrorAction Stop | Out-Null
    [IO.File]::WriteAllText((Join-Path $LockDir 'info'), "$PID $NowS", $Utf8); return $true
  } catch { return $false }
}
if (-not (Take-Lock)) {
  if ($Now) {   # установщику — подождать идущий запуск, но не дольше минуты
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 2; if (Take-Lock) { $ok = $true; break } }
    if (-not $ok) { Log 'копия уже идёт другим запуском — подождите минуту и повторите'; exit 3 }
  } else { Log 'копия уже идёт другим запуском — этот пропускаю'; exit 0 }
}
$PartName = ".part-$PID.sql.gz"
# недокачанные копии прошлых запусков (остановлены, выключение, предел Планировщика) — под блокировкой убираем
Get-ChildItem -LiteralPath $Dest -Force -Filter '.part-*.sql.gz' -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne $PartName } | Remove-Item -Force -ErrorAction SilentlyContinue

function Finish([int]$code) {
  Remove-Item -LiteralPath (Join-Path $Dest $PartName) -Force -ErrorAction SilentlyContinue
  # incoming НЕ чистим: остатки оборванной докачки подберёт следующий запуск (см. Files-Step).
  # Блокировку снимаем только СВОЮ: если нас остановили как зависших, её уже взял другой запуск.
  $mine = $false
  try { $mine = (([IO.File]::ReadAllText((Join-Path $LockDir 'info'))).Trim() -split ' ')[0] -eq "$PID" } catch {}
  if ($mine) { Remove-Item -LiteralPath $LockDir -Recurse -Force -ErrorAction SilentlyContinue }
  exit $code
}

# журнал не растёт без конца
try {
  if (Test-Path -LiteralPath $LogFile) {
    $all = [IO.File]::ReadAllLines($LogFile, $Utf8)
    if ($all.Count -gt 1100) { [IO.File]::WriteAllLines($LogFile, $all[($all.Count - 1000)..($all.Count - 1)], $Utf8Bom) }
  }
} catch {}

# ---------- внешние программы ----------
function Run([string]$exe, [string]$argline, [string]$cwd = $null, [int]$timeout = 600) {
  if (-not $exe) { return @{ Code = 127; Out = ''; Err = 'program not found' } }
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
    try { $p.Kill() } catch {}
    $p.WaitForExit() | Out-Null
    return @{ Code = 255; Out = ''; Err = 'Connection timed out (killed)' }
  }
  $p.WaitForExit()
  return @{ Code = $p.ExitCode; Out = $o.Result; Err = $e.Result }
}

# ---------- ssh: ошибки разбираем по ТЕКСТУ ----------
# Код 255 — это и «нет связи», и «ключ не подходит», и «нет настройки taska». Повторять есть смысл
# только при обрыве связи; остальное само не пройдёт, и человеку нужен точный совет.
function No-Alias {
  # в настройке ssh нет своего адреса для «taska» — значит, блока Host taska нет
  # (VPN с подменой DNS «находит» любое имя, и ssh пишет не «Could not resolve», а «Connection closed»)
  if ($HostName -match '[.:]') { return $false }
  $r = Run $Ssh "-G $SshOpts $HostName" $null 20
  foreach ($l in ($r.Out -split "`n")) { if ($l.Trim() -eq "hostname $HostName") { return $true } }
  return $false
}
function Kind-Of($r) {
  if ($r.Code -eq 0) { return 'ok' }
  if (-not $Ssh) { return 'nossh' }
  $e = $r.Err
  if ($r.Code -eq 255 -and (No-Alias)) { return 'nohost' }
  if ($e -match "Could not resolve hostname $([regex]::Escape($HostName)):") { return 'nohost' }
  if ($e -match 'Permission denied \(|Too many authentication failures|no such identity|UNPROTECTED PRIVATE KEY|Load key') { return 'key' }
  if ($e -match 'IDENTIFICATION HAS CHANGED|Host key verification failed') { return 'hostkey' }
  if ($e -match 'Connection refused|timed out|Connection closed|Connection reset|No route to host|Network is unreachable|Could not resolve hostname|kex_exchange_identification|Broken pipe|forcibly closed') { return 'net' }
  if ($r.Code -eq 255) { return 'net' }
  return 'remote'
}
function Msg-Of([string]$k, $r) {
  switch ($k) {
    'net'     { return 'нет связи с сервером. Проверьте интернет; рабочий Wi-Fi иногда закрывает вход на серверы — попробуйте другую сеть. Копия сделается сама, когда связь появится.' }
    'key'     { return 'ключ этого компьютера больше не подходит к серверу (так бывает, если «Подключить помощника» нажали на другом компьютере). Пройдите на этом компьютере шаг «Подключить помощника» из памятки.' }
    'hostkey' { return 'сервер переустановлен или заменён. Пройдите шаг «Подключить помощника» из памятки.' }
    'nohost'  { return "на этом компьютере нет входа «ssh $HostName». Пройдите шаг «Подключить помощника» из памятки." }
    'nossh'   { return 'в Windows не нашёлся OpenSSH (ssh.exe). Скажите помощнику: «включи клиент OpenSSH в Windows».' }
    default   { $t = ($r.Err -split "`n" | Where-Object { $_.Trim() } | Select-Object -Last 1); return "сервер ответил ошибкой: $t" }
  }
}
# команда на сервере; при обрыве связи повторяет. Итог — в $script:Kind
function RSsh([string]$cmd) {
  $delays = @($RetryDelays) + @('last')
  foreach ($d in $delays) {
    $r = Run $Ssh "-n $SshOpts $HostName $cmd" $null 300
    $script:Kind = Kind-Of $r
    if ($script:Kind -ne 'net' -or "$d" -eq 'last') { return $r }
    Log "нет связи с сервером — ещё попытка через $d с"
    Start-Sleep -Seconds ([int]$d)
  }
}

# Целый ли gzip и настоящая ли внутри база. .NET 4 не всегда ругается на обрезанный архив,
# поэтому дополнительно сверяем длину распакованного с последними 4 байтами файла (поле ISIZE).
function Test-Dump([string]$path) {
  $fs = $null
  try {
    $fs = [IO.File]::OpenRead($path)
    if ($fs.Length -lt 20) { return $false }
    $tail = New-Object byte[] 4
    $fs.Seek(-4, [IO.SeekOrigin]::End) | Out-Null; $fs.Read($tail, 0, 4) | Out-Null
    $isize = [BitConverter]::ToUInt32($tail, 0)
    $fs.Seek(0, [IO.SeekOrigin]::Begin) | Out-Null
    $gz = New-Object IO.Compression.GZipStream($fs, [IO.Compression.CompressionMode]::Decompress)
    $buf = New-Object byte[] 65536; $head = New-Object IO.MemoryStream; [int64]$total = 0
    while (($n = $gz.Read($buf, 0, $buf.Length)) -gt 0) {
      if ($head.Length -lt 4096) { $head.Write($buf, 0, [math]::Min($n, 4096)) }
      $total += $n
    }
    if (($total % 4294967296) -ne $isize) { return $false }
    return $Utf8.GetString($head.ToArray()).Contains('PostgreSQL database dump')
  } catch { return $false } finally { if ($fs) { $fs.Dispose() } }
}

$script:Problem = ''; $script:PMsg = ''; $script:Contact = $false; $script:DbOk = $false
$script:Result = ''; $script:FPMsg = ''; $script:Kind = ''
function Copies { return @(Get-ChildItem -LiteralPath $Dest -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '^taska-\d{4}-\d{2}-\d{2}\.sql\.gz$' } | Sort-Object Name) }
function FreeBytes {
  try { return [int64](New-Object IO.DriveInfo ([IO.Path]::GetPathRoot((Resolve-Path -LiteralPath $Dest).ProviderPath))).AvailableFreeSpace } catch { return [int64]0 }
}

# ---------- база ----------
function Fetch-Db([string]$n, [string]$sha) {   # 0 — готово, 1 — ошибка скачивания, 2 — файл на сервере битый
  $part = Join-Path $Dest $PartName
  $free = FreeBytes
  if ($free -lt 200MB) { $script:Problem = 'disk'; $script:PMsg = "на этом компьютере кончается место (свободно $(HSize $free))."; return 1 }
  $r = Run $Scp "-q $SshOpts ${HostName}:$Remote/backups/$n $PartName" $Dest 1800
  $k = Kind-Of $r
  if ($k -ne 'ok') {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    if ($k -in @('net', 'key', 'hostkey', 'nohost', 'nossh')) { $script:Problem = $k; $script:PMsg = Msg-Of $k $r }
    else { $script:Problem = 'download'; $script:PMsg = 'копия не скачалась. Попробую ещё раз при следующем запуске.' }
    return 1
  }
  $got = (Get-FileHash -LiteralPath $part -Algorithm SHA256).Hash
  if ($got -ne $sha) {
    Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue
    $script:Problem = 'download'; $script:PMsg = 'копия скачалась с ошибкой. Попробую ещё раз при следующем запуске.'; return 1
  }
  if (-not (Test-Dump $part)) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; return 2 }
  $final = Join-Path $Dest "taska-$n"
  Move-Item -LiteralPath $part -Destination $final -Force
  $size = (Get-Item -LiteralPath $final).Length
  Set-State 'last_copy' "$NowS taska-$n $size"
  Log "скачана копия базы taska-$n ($(HSize $size)), проверена"
  return 0
}

function Db-Step {
  $r = RSsh "ls -1 $Remote/backups"
  if ($script:Kind -eq 'remote') { $script:Problem = 'server'; $script:PMsg = 'на сервере нет папки с копиями. Скажите помощнику: «настрой ночную копию по README» — это промпт 1 шага «Резервная копия».'; return }
  if ($script:Kind -ne 'ok') { $script:Problem = $script:Kind; $script:PMsg = Msg-Of $script:Kind $r; return }
  $script:Contact = $true
  $names = @($r.Out -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d{4}-\d{2}-\d{2}\.sql\.gz$' } | Sort-Object -Descending)
  if ($names.Count -eq 0) { $script:Problem = 'server'; $script:PMsg = 'на сервере нет ни одной ночной копии. Сначала промпт 1 шага «Резервная копия».'; return }
  $newest = $names[0]; $brokenNewest = $false; $got = ''; $tries = 0
  $badFile = Join-Path $StateDir 'bad'
  $bad = @(); if (Test-Path -LiteralPath $badFile) { $bad = @([IO.File]::ReadAllLines($badFile) | ForEach-Object { $_.Trim().ToLower() }) }
  # Берём самую свежую, которой у нас нет. Битая на сервере — следующую по дате (но тревога будет).
  foreach ($n in $names) {
    if (Test-Path -LiteralPath (Join-Path $Dest "taska-$n")) { break }   # эта уже есть — значит, и все старше неё
    $tries++; if ($tries -gt 5) { break }
    $s = RSsh "sha256sum $Remote/backups/$n"
    if ($script:Kind -eq 'remote') { continue }
    if ($script:Kind -ne 'ok') { $script:Problem = $script:Kind; $script:PMsg = Msg-Of $script:Kind $s; return }
    $sha = ($s.Out.Trim() -split '\s+')[0].ToLower()
    if ($bad -contains "$n $sha") { if ($n -eq $newest) { $brokenNewest = $true }; continue }
    $rc = Fetch-Db $n $sha
    if ($rc -eq 0) { $got = $n; break }
    if ($rc -eq 2) {
      [IO.File]::AppendAllText($badFile, "$n $sha`n", $Utf8); Log "копия $n на сервере битая — не беру"
      if ($n -eq $newest) { $brokenNewest = $true }
      continue
    }
    return
  }
  $nd = $newest -replace '\.sql\.gz$', ''
  if ($brokenNewest) {
    $script:Problem = 'server'; $script:PMsg = "свежая копия на сервере (за $(DayOf $nd)) битая — ночная копия работает неправильно. Скажите помощнику: «проверь ночную копию по README»."
  } elseif ($nd -lt $NowT.AddDays(-2).ToString('yyyy-MM-dd')) {
    # сервер перестал делать ночные копии: cron сломался, кончился диск…
    $script:Problem = 'server'; $script:PMsg = "ночная копия на сервере не делается с $(DayOf $nd). Скажите помощнику: «проверь ночную копию по README»."
    $c = RSsh 'crontab -l'
    if ($script:Kind -ne 'net' -and $c.Out -notmatch 'backup\.sh') { $script:PMsg += ' В расписании сервера её нет.' }
  } else { $script:DbOk = $true }
  if ($got) { $script:Result = "скачана новая копия taska-$got" }
  elseif (-not $script:Problem) { $script:Result = "новых копий на сервере пока нет, последняя (taska-$newest) уже здесь" }
}

# ---------- файлы задач: только новое ----------
function Read-Tsv([string]$path) {   # путь → "размер`tвремя"
  $h = @{}
  if (Test-Path -LiteralPath $path) {
    foreach ($l in [IO.File]::ReadAllLines($path, $Utf8)) { $f = $l -split "`t"; if ($f.Count -eq 3) { $h[$f[2]] = "$($f[0])`t$($f[1])" } }
  }
  return $h
}
function Files-Step {
  $r = RSsh "bash $Remote/scripts/laptop/files-list.sh"
  if ($script:Kind -eq 'remote') {
    if ($r.Out -match '^NO-STORAGE') { $script:FPMsg = 'на сервере не нашёл хранилище файлов задач.' }
    else { $script:FPMsg = 'на сервере старая версия скриптов копии. Обновите её: повторите промпт 2 шага «Резервная копия».' }
    return
  }
  if ($script:Kind -ne 'ok') { $script:FPMsg = Msg-Of $script:Kind $r; return }
  $lines = @($r.Out -split "`n" | ForEach-Object { $_.TrimEnd("`r") } | Where-Object { $_ })
  $rdir = ''; if ($lines.Count -gt 0 -and $lines[0].StartsWith("DIR`t")) { $rdir = $lines[0].Substring(4) }
  $remote = [ordered]@{}
  foreach ($l in ($lines | Select-Object -Skip 1)) {
    $f = $l -split "`t"
    # кавычки, шаблоны и запрещённые в Windows знаки сломали бы скачивание — такие пропускаем (у Таски их не бывает)
    if ($f.Count -eq 3 -and $f[2] -notmatch '["\\*?\[<>|:]') { $remote[$f[2]] = @([int64]$f[0], $f[1]) }
  }
  if (-not $rdir -or -not $remote.Contains('.minio.sys/format.json')) {
    $script:FPMsg = 'список файлов с сервера пришёл неполным — попробую в следующий раз.'; return   # и ничего не трогаем
  }
  New-Item -ItemType Directory -Force -Path $FilesDir | Out-Null
  $haveFile = Join-Path $StateDir 'files.have'; $goneFile = Join-Path $StateDir 'files.gone'
  $have = Read-Tsv $haveFile
  # списки — List, а не «$x += …»: на десятках тысяч файлов MinIO += копирует массив каждый раз (O(n²))
  $gotList = New-Object 'System.Collections.Generic.List[string]'
  # Остатки оборванной докачки (Планировщик убил задачу по времени, выключение, сон): докачанное целиком
  # кладём на место, а не качаем заново — иначе на медленной связи первая полная копия не закончилась бы
  # никогда (замечание критика 12.11.2026). Берём файл, только если на сервере он всё тот же.
  $inc = Join-Path $StateDir 'incoming'
  $needFile = Join-Path $inc 'need.tsv'
  if (Test-Path -LiteralPath $needFile) {
    foreach ($kv in (Read-Tsv $needFile).GetEnumerator()) {
      $p = $kv.Key
      if (-not $remote.Contains($p) -or "$($remote[$p][0])`t$($remote[$p][1])" -ne $kv.Value) { continue }
      $src = Join-Path $inc ($p.Replace('/', '\'))
      if ((Test-Path -LiteralPath $src) -and (Get-Item -LiteralPath $src).Length -eq $remote[$p][0]) {
        $dst = Join-Path $FilesDir ($p.Replace('/', '\'))
        New-Item -ItemType Directory -Force -Path (Split-Path -Path $dst -Parent) | Out-Null
        Move-Item -LiteralPath $src -Destination $dst -Force
        $gotList.Add($p); $have[$p] = $kv.Value
      }
    }
    if ($gotList.Count -gt 0) { Log "файлы задач: с прошлой оборванной докачки взял готовых $($gotList.Count)" }
  }
  Remove-Item -LiteralPath $inc -Recurse -Force -ErrorAction SilentlyContinue
  $local = @{}
  $root = (Resolve-Path -LiteralPath $FilesDir).ProviderPath.TrimEnd('\', '/')
  foreach ($fi in (Get-ChildItem -LiteralPath $FilesDir -Recurse -File -Force -ErrorAction SilentlyContinue)) {
    $local[$fi.FullName.Substring($root.Length + 1).Replace('\', '/')] = $fi.Length
  }
  # нужно: нового нет у нас, изменился (размер/время на сервере) или наш файл пропал/недокачан
  $need = New-Object 'System.Collections.Generic.List[string]'
  foreach ($p in $remote.Keys) {
    $sz = $remote[$p][0]; $mt = $remote[$p][1]
    if (-not ($have.ContainsKey($p) -and $have[$p] -eq "$sz`t$mt" -and $local.ContainsKey($p) -and $local[$p] -eq $sz)) { $need.Add($p) }
  }
  [int64]$needB = 0; foreach ($p in $need) { $needB += $remote[$p][0] }
  $missing = 0; $failed = $false
  if ($need.Count -gt 0) {
    $free = FreeBytes
    if ($needB + 1GB -gt $free) { $script:FPMsg = "на этом компьютере мало места: для файлов задач нужно ещё $(HSize $needB), свободно $(HSize $free)."; return }
    Log "файлы задач: докачиваю $($need.Count) ($(HSize $needB))"
    # Качаем во временную папку одним соединением, на место кладём только проверенное по размеру:
    # оборванная докачка не оставит в копии полфайла. Пути в пакете — относительные, только латиница.
    # Список need.tsv — для подбора остатков, если нас оборвут (см. выше).
    New-Item -ItemType Directory -Force -Path $inc | Out-Null
    $batch = New-Object System.Text.StringBuilder; $nl = New-Object System.Text.StringBuilder
    $dirs = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($p in $need) {
      $dir = Split-Path -Path ($p.Replace('/', '\')) -Parent
      if ($dir -and $dirs.Add($dir)) { New-Item -ItemType Directory -Force -Path (Join-Path $inc $dir) | Out-Null }
      [void]$batch.Append("-get `"$rdir/$p`" `"$p`"`n")
      [void]$nl.Append("$($remote[$p][0])`t$($remote[$p][1])`t$p`n")
    }
    [IO.File]::WriteAllText($needFile, $nl.ToString(), $Utf8)
    [IO.File]::WriteAllText((Join-Path $inc 'batch.txt'), $batch.ToString(), $Utf8)
    # Предел sftp (3 ч) меньше предела задачи в Планировщике (4 ч, install-windows.ps1): успеваем
    # переложить скачанное и записать учёт. А если задачу всё же убьют — остатки подберёт следующий запуск.
    $sr = Run $Sftp "-q -b batch.txt $SshOpts $HostName" $inc 10800
    foreach ($p in $need) {
      $src = Join-Path $inc ($p.Replace('/', '\'))
      if ((Test-Path -LiteralPath $src) -and (Get-Item -LiteralPath $src).Length -eq $remote[$p][0]) {
        $dst = Join-Path $FilesDir ($p.Replace('/', '\'))
        New-Item -ItemType Directory -Force -Path (Split-Path -Path $dst -Parent) | Out-Null
        Move-Item -LiteralPath $src -Destination $dst -Force
        $gotList.Add($p)
      } else { $missing++ }
    }
    Remove-Item -LiteralPath $inc -Recurse -Force -ErrorAction SilentlyContinue
    if ($sr.Code -ne 0) { $failed = $true }
  }
  # учёт: что у нас есть (по данным сервера) и что пропало с сервера
  foreach ($p in $gotList) { $have[$p] = "$($remote[$p][0])`t$($remote[$p][1])" }
  $gone = @{}
  if (Test-Path -LiteralPath $goneFile) { foreach ($l in [IO.File]::ReadAllLines($goneFile, $Utf8)) { $f = $l -split "`t"; if ($f.Count -eq 2) { $gone[$f[1]] = $f[0] } } }
  $newGone = @{}
  foreach ($p in @($have.Keys)) { if (-not $remote.Contains($p)) { $newGone[$p] = $(if ($gone.ContainsKey($p)) { $gone[$p] } else { $Today }) } }
  # удалённое на сервере держим GoneDays дней — вдруг удалили по ошибке; потом убираем и у себя
  $cut = $NowT.AddDays(-$GoneDays).ToString('yyyy-MM-dd'); $expired = 0
  foreach ($p in @($newGone.Keys)) {
    if ($newGone[$p] -lt $cut) {
      Remove-Item -LiteralPath (Join-Path $FilesDir ($p.Replace('/', '\'))) -Force -ErrorAction SilentlyContinue
      $have.Remove($p); $newGone.Remove($p); $expired++
    }
  }
  if ($expired -gt 0) {
    Get-ChildItem -LiteralPath $FilesDir -Recurse -Directory -Force | Sort-Object { $_.FullName.Length } -Descending |
      Where-Object { -not (Get-ChildItem -LiteralPath $_.FullName -Force) } | Remove-Item -Force -ErrorAction SilentlyContinue
    Log "файлы задач: убрал $expired удалённых на сервере больше $GoneDays дней назад"
  }
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $have.Keys) { [void]$sb.Append("$($have[$p])`t$p`n") }
  [IO.File]::WriteAllText($haveFile, $sb.ToString(), $Utf8)
  $sb = New-Object System.Text.StringBuilder
  foreach ($p in $newGone.Keys) { [void]$sb.Append("$($newGone[$p])`t$p`n") }
  [IO.File]::WriteAllText($goneFile, $sb.ToString(), $Utf8)
  if ($failed) {
    $script:FPMsg = "докачка файлов задач оборвалась ($($gotList.Count) из $($need.Count) готово) — продолжу в следующий раз."
    Log "файлы задач: $($script:FPMsg)"; return
  }
  if ($missing -gt 0) { Log "файлы задач: $missing не скачались (их, видимо, только что удалили) — проверю в следующий раз" }
  Set-State 'files_day' $Today; Set-State 'files_ok' $NowS
  Log "файлы задач сверены: $($have.Count) $(Files-Word $have.Count), новых $($gotList.Count)"
}

# ---------- запуск ----------
if (-not $Now) {
  Set-State 'last_sched' $NowS
  $c = @(Copies)
  $nlDay = ''; if ($c.Count -gt 0) { $nlDay = $c[-1].Name.Substring(6, 10) }
  # Решаем по файлам, а не по часам: копия с сегодняшней датой есть и файлы сегодня сверены — сеть не трогаем.
  # Отметки на сервере тоже должны быть сегодняшние: не поставилась (обрыв) — повторим через час.
  if ($nlDay -and $nlDay -ge $Today -and (Read-Line 'files_day') -eq $Today -and (Read-Line 'mark_day') -eq $Today -and (Read-Line 'fmark_day') -eq $Today) {
    Log 'запуск по расписанию: копия за сегодня уже есть'; Finish 0
  }
  Log "запуск по расписанию (версия $Version)"
} else { Log "запуск вручную (версия $Version)" }

Db-Step
if (-not $Now -and $script:Contact -and (Read-Line 'files_day') -ne $Today) {
  Files-Step
  # причина сбоя файлов — и в журнал, не только в «Последняя копия.txt» (её каждый запуск переписывает); обрыв докачки уже записан
  if ($script:FPMsg -and $script:FPMsg -notmatch '^докачка') { Log "файлы задач: $($script:FPMsg)" }
}

# храним Keep самых свежих копий базы
$c = @(Copies)
if ($c.Count -gt $Keep) {
  foreach ($f in ($c | Select-Object -First ($c.Count - $Keep))) { Remove-Item -LiteralPath $f.FullName -Force; Log "старая копия $($f.Name) удалена (храню $Keep)" }
}

# Отметки для ночного отчёта сервера — раз в день, каждая своя (замечание критика 12.11.2026):
#   .laptop-ok — база забрана; .laptop-files-ok — файлы задач сверены. Первая отметка базы заводит
#   и вторую, если её ещё нет, — от неё и пойдёт отсчёт «не забирал файлы задач».
if ($script:DbOk) {
  Set-State 'last_good' $NowS
  if ((Read-Line 'mark_day') -ne $Today) {
    # (без кавычек: ssh склеит слова в одну строку, && и { } разберёт оболочка сервера)
    RSsh "touch $Remote/backups/.laptop-ok && { [ -e $Remote/backups/.laptop-files-ok ] || touch $Remote/backups/.laptop-files-ok; }" | Out-Null
    if ($script:Kind -eq 'ok') { Set-State 'mark_day' $Today }
  }
}
if ((Read-Line 'files_day') -eq $Today -and (Read-Line 'fmark_day') -ne $Today) {
  RSsh "touch $Remote/backups/.laptop-files-ok" | Out-Null
  if ($script:Kind -eq 'ok') { Set-State 'fmark_day' $Today }
}
if ($script:Problem) { Log "ОШИБКА: $($script:PMsg)" }

# ---------- «Последняя копия.txt» ----------
$lastGood = Read-Num 'last_good'; $installed = Read-Num 'installed'
$since = if ($lastGood) { $lastGood } elseif ($installed) { $installed } else { $NowS }
$st = New-Object System.Text.StringBuilder
if ($script:Problem) {
  if ($script:Problem -eq 'server') { [void]$st.AppendLine("ВНИМАНИЕ: $($script:PMsg)") }
  else { [void]$st.AppendLine("ВНИМАНИЕ: копия не обновлялась с $((FromUnix $since).ToString('dd.MM.yyyy')): $($script:PMsg)") }
  [void]$st.AppendLine()
}
[void]$st.AppendLine("Копия Таски на этом компьютере (версия $Version).")
$lc = Read-Line 'last_copy'
if ($lc) { $p = $lc -split ' '; [void]$st.AppendLine("Последняя скачанная копия базы: $((FromUnix ([int64]$p[0])).ToString('dd.MM.yyyy HH:mm')) — $($p[1]) ($(HSize ([double]$p[2]))), проверена.") }
else { [void]$st.AppendLine('Копий базы пока нет.') }
$fok = Read-Num 'files_ok'
if ($fok) {
  $hv = Read-Tsv (Join-Path $StateDir 'files.have'); [double]$fb = 0; foreach ($v in $hv.Values) { $fb += [double](($v -split "`t")[0]) }
  [void]$st.AppendLine("Файлы задач: $($hv.Count) $(Files-Word $hv.Count) ($(HSize $fb)), сверены с сервером $((FromUnix $fok).ToString('dd.MM.yyyy HH:mm')).")
} else { [void]$st.AppendLine('Файлы задач: ещё не копировались.') }
if ($script:FPMsg) { [void]$st.AppendLine("Файлы задач сейчас: $($script:FPMsg)") }
if ($script:Problem) { [void]$st.AppendLine("Последняя проверка: $($NowT.ToString('dd.MM.yyyy HH:mm')) — не вышло (см. первую строку).") }
else { [void]$st.AppendLine("Последняя проверка: $($NowT.ToString('dd.MM.yyyy HH:mm')) — $($script:Result).") }
[void]$st.AppendLine("Копий базы на этом компьютере: $(@(Copies).Count) (храню $Keep).")
[void]$st.AppendLine()
[void]$st.AppendLine('Папка files — копия хранилища файлов Таски (договоры, фото). Открыть файл прямо из неё нельзя: её возвращают в Таску целиком, см. README «Копия на ноутбук».')
try { Write-Text $StatusFile $st.ToString() } catch {}

# ---------- окно тревоги: не чаще раза в сутки и не блокируя запуск ----------
function Alarm([string]$text) {
  $last = Read-Num 'last_alarm'; if (-not $last) { $last = 0 }
  if (($NowS - $last) -lt 86400) { return }
  Set-State 'last_alarm' $NowS          # сначала отметка, потом окно: упавшее окно не повторится каждый час
  Log "показываю окно: $text"
  $title = 'Копия Таски не делается'
  $body = "$text`n`nПодробности — в папке TaskaBackup, файл «Последняя копия.txt»."
  if ($env:TASKA_ALERT_CMD) { Start-Process -FilePath $env:TASKA_ALERT_CMD -ArgumentList @("`"$title`"", "`"$($body -replace '"', "'")`"") -WindowStyle Hidden; return }
  # Текст передаём внутри закодированной команды: так кавычки и переводы строк не ломаются.
  $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
  $code = "Add-Type -AssemblyName System.Windows.Forms; `$f = New-Object System.Windows.Forms.Form; `$f.TopMost = `$true; " +
          "[void][System.Windows.Forms.MessageBox]::Show(`$f, $(& $q $body), $(& $q $title), 'OK', 'Warning'); `$f.Dispose()"
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($code))
  try { Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $enc) -WindowStyle Hidden } catch {}
}
if (-not $Now) {
  $quiet = $NowS - $since; $reason = ''
  $from = (FromUnix $since).ToString('dd.MM')
  switch ($script:Problem) {
    '' {}
    'server' { $reason = $script:PMsg; if ($reason) { $reason = $reason.Substring(0, 1).ToUpper() + $reason.Substring(1) } }   # сам не пройдёт — сразу; с заглавной, как остальные окна
    { $_ -in @('key', 'hostkey', 'nohost', 'nossh') } { if ($quiet -ge 86400) { $reason = "Копии нет с ${from}: $($script:PMsg)" } }
    'net' { if ($quiet -ge 259200) { $reason = "Копии нет с ${from}: сервер не отвечает. Откройте свою Таску в браузере. Не открывается — сервер выключен или не оплачен: зайдите в кабинет hoster.kz. Открывается — рабочий Wi-Fi иногда закрывает вход на серверы: попробуйте другую сеть, а если не поможет, скажите помощнику «проверь копию Таски на этом компьютере по README»." } }
    default { if ($quiet -ge 259200) { $reason = "Копии нет с ${from}: $($script:PMsg)" } }   # прочее: 3 дня
  }
  if (-not $reason -and $script:FPMsg) {
    $fok2 = Read-Num 'files_ok'; $base = if ($fok2) { $fok2 } elseif ($installed) { $installed } else { $NowS }
    if (($NowS - $base) -ge 259200) { $reason = "Файлы задач не копируются: $($script:FPMsg)" }
  }
  if ($reason) { Alarm $reason }
}

if ($script:Problem) { Finish 1 }
Finish 0
