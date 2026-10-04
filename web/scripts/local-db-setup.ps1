# One-time (and re-runnable) setup for running the pgTAP suite on this machine.
#
# WHY THIS EXISTS. test-db.sh needs a Postgres server AND a `psql` client. CI has
# both (postgresql:16 with postgresql-16-pgtap). A developer machine had neither:
# Docker is not installed, the EnterpriseDB installer is 403 behind this network,
# and this document records that every gate failure therefore cost a push. That
# cost is paid per migration and has been paid since Phase 1.
#
# What this assembles, and why each part is the way it is:
#
#   server   @embedded-postgres/windows-x64 from npm. It is the only Windows
#            PostgreSQL build installable here, but it ships initdb/pg_ctl/
#            postgres and NO client and NO pgTAP, so both gaps are filled below.
#   pgTAP    v1.3.4 from the pgTAP project. It is pure SQL/PLpgSQL, so it needs no
#            compiler - just pgtap.control and one version file in share/
#            extension. (Zonky's build omits it; the 61 extensions it does ship
#            were checked and pgTAP is not among them.)
#   psql     scripts/psql-shim.js over the node `pg` driver, wrapped by a `psql`
#            launcher on PATH.
#
# Two Windows-specific things that cost time and are worth not rediscovering:
#
#   1. `shared_buffers` MUST be small. At the default the postmaster logged
#      "could not reserve shared memory region ... error code 487" and could not
#      fork a backend, so every connection hung and looked like a dead server.
#      16MB is plenty for a throwaway test database.
#   2. pg_ctl -w start HANGS rather than returning on this setup. Start it with
#      Start-Process and poll the port instead.
$ErrorActionPreference = 'Stop'

$Root    = Split-Path -Parent $PSScriptRoot          # web/
$Repo    = Split-Path -Parent $Root                   # repo root
$Local   = Join-Path $Root '.local-db'                # binaries + data (gitignored)
$BinDir  = Join-Path $Local 'bin'
$DataDir = Join-Path $Local 'data'
$PgTapVer = '1.3.4'
$Port    = 5432

function Say($m) { Write-Host "==> $m" }

# ---------------------------------------------------------------- server ----
# Create the directory before anything reads or chdirs into it. Checking
# $BinDir alone is not enough: $BinDir is only absent for the same reason $Local
# is, so the first run fell through to Push-Location on a directory that did not
# exist yet.
New-Item -ItemType Directory -Force -Path $Local | Out-Null
if (-not (Test-Path $BinDir)) {
  Say 'installing the PostgreSQL server binaries (first run only)'
  Push-Location $Local
  if (-not (Test-Path (Join-Path $Local 'package.json'))) {
    '{"name":"lensy-local-db","private":true}' | Out-File -FilePath (Join-Path $Local 'package.json') -Encoding utf8
  }
  cmd /c "npm install @embedded-postgres/windows-x64 --no-audit --no-fund --loglevel=error"
  if ($LASTEXITCODE -ne 0) { throw 'npm install of the PostgreSQL binaries failed' }
  Pop-Location
}
$Native = Join-Path $Local 'node_modules\@embedded-postgres\windows-x64\native'
$Bin    = Join-Path $Native 'bin'
if (-not (Test-Path (Join-Path $Bin 'initdb.exe'))) { throw "server binaries missing under $Bin" }

# ----------------------------------------------------------------- pgTAP ----
$PgtapCtl = Join-Path $Native 'share\extension\pgtap.control'
if (-not (Test-Path $PgtapCtl)) {
  Say "installing pgTAP $PgTapVer (first run only)"
  $Tgz = Join-Path $Local 'pgtap.tar.gz'
  $Url = "https://codeload.github.com/theory/pgtap/tar.gz/refs/tags/v$PgTapVer"
  Invoke-WebRequest -Uri $Url -OutFile $Tgz -UseBasicParsing
  $Ex = Join-Path $Local 'pgtap-src'
  Remove-Item $Ex -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $Ex | Out-Null
  tar -xzf $Tgz -C $Ex
  $Src = (Get-ChildItem $Ex -Directory)[0].FullName
  # pgtap.sql.in carries no @var@ placeholders despite the extension, so it can
  # be installed verbatim as the version file.
  Copy-Item (Join-Path $Src 'pgtap.control') $PgtapCtl -Force
  Copy-Item (Join-Path $Src 'sql\pgtap.sql.in') (Join-Path $Native 'share\extension\pgtap--1.3.4.sql') -Force
}

# ------------------------------------------------------------- psql shim ----
$ShimDir = Join-Path $Local 'shim'
New-Item -ItemType Directory -Force -Path $ShimDir | Out-Null
$ShimJs   = (Join-Path $PSScriptRoot 'psql-shim.js') -replace '\\', '/'

# TWO launchers, because two shells have to find it. An earlier version wrote
# only a @echo-off batch file named `psql` with no extension, which Git Bash
# cannot execute at all - `psql: command not found`, while the same launcher
# worked from cmd. bash needs a shebang; cmd needs psql.cmd.
$UnixLauncher = Join-Path $ShimDir 'psql'
$CmdLauncher  = Join-Path $ShimDir 'psql.cmd'

if (-not (Test-Path $UnixLauncher) -or (Get-Content $UnixLauncher -Raw) -notmatch [regex]::Escape($ShimJs)) {
  # LF ONLY, and written with [IO.File] rather than Out-File on purpose.
  # Out-File emits CRLF on Windows, which turns the shebang into
  # "#!/usr/bin/env bash\r" - the interpreter is then not found and the failure
  # surfaces as `psql: command not found` (exit 127) with nothing pointing at
  # line endings. That is exactly what happened here.
  $unix = "#!/usr/bin/env bash`nexec node `"$ShimJs`" `"`$@`"`n"
  [IO.File]::WriteAllText($UnixLauncher, $unix, (New-Object Text.UTF8Encoding($false)))
}
if (-not (Test-Path $CmdLauncher) -or (Get-Content $CmdLauncher -Raw) -notmatch [regex]::Escape($ShimJs)) {
  "@echo off`r`nnode `"$ShimJs`" %*`r`n" |
    Out-File -FilePath $CmdLauncher -Encoding ascii
}

# ----------------------------------------------------------------- start ----
if (-not (Test-Path $DataDir)) {
  Say 'initdb (first run only)'
  & (Join-Path $Bin 'initdb.exe') -D $DataDir -U postgres --auth=trust --encoding=UTF8 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'initdb failed' }

  # See note (1) at the top: the default shared_buffers cannot fork a backend here.
  @"

# --- lensy local test database -------------------------------------------
# Windows cannot reserve the default shared memory region for a new backend
# (error 487), so every connection hangs. A throwaway test database needs
# almost none of it.
shared_buffers = 16MB
max_connections = 10
work_mem = 1MB
maintenance_work_mem = 16MB
autovacuum = off
max_worker_processes = 2
max_parallel_workers = 0
listen_addresses = 'localhost'
port = $Port
"@ | Out-File -FilePath (Join-Path $DataDir 'postgresql.conf') -Append -Encoding ascii
}

$Listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $Listening) {
  Say 'starting the server'
  Start-Process -FilePath (Join-Path $Bin 'pg_ctl.exe') `
                -ArgumentList @('-D', $DataDir, '-l', (Join-Path $Local 'server.log'), '-w', 'start') `
                -NoNewWindow | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { break }
  }
  if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    throw "the server did not start - see $(Join-Path $Local 'server.log')"
  }
}

Say "server is up on localhost:$Port"
Write-Host ""
Write-Host "Run the gates with:"
Write-Host "  cd $Repo"
Write-Host "  web\scripts\test-db-local.sh          (Git Bash)"
Write-Host ""
Write-Host "or:  npm run test:db:local"
Write-Host ""
Write-Host "The database is throwaway: recreate it before a run with"
Write-Host "  drop database if exists lensy; create database lensy;"
