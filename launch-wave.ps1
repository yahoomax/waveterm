$ErrorActionPreference = 'Stop'

$repoRoot = $PSScriptRoot
Set-Location $repoRoot

$nodeBin = 'C:\Users\lakmald\tools\node-v22.23.1-win-x64'
if (Test-Path $nodeBin) {
	$env:Path = "$nodeBin;$env:Path"
}

$zigBin = 'C:\Users\lakmald\tools\zig-x86_64-windows-0.16.0'
if (Test-Path $zigBin) {
	$env:Path = "$zigBin;$env:Path"
}

$goBin = 'C:\Program Files\Go\bin\go.exe'
if (Test-Path $goBin) {
	$env:CC = 'zig cc -target x86_64-windows-gnu'
	$env:CGO_ENABLED = '1'
	& $goBin build -o dist/bin/wavesrv.x64.exe cmd/server/main-server.go
}

$env:WAVETERM_ENVFILE = Join-Path $repoRoot '.env'
$env:WCLOUD_PING_ENDPOINT = 'https://ping-dev.waveterm.dev/central'
$env:WCLOUD_ENDPOINT = 'https://api-dev.waveterm.dev/central'
$env:WCLOUD_WS_ENDPOINT = 'wss://wsapi-dev.waveterm.dev'
$env:WAVETERM_NOCONFIRMQUIT = '1'

npm run dev