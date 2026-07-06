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

$machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
$env:Path = "$zigBin;$nodeBin;$machinePath;$userPath"

$electronDist = Join-Path $repoRoot 'node_modules\electron\dist'
$makeDir = Join-Path $repoRoot 'make'
$winUnpackedDir = Join-Path $makeDir 'win-unpacked'

$pkg = Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = $pkg.version
$zipPath = Join-Path $makeDir ("Wave-win32-x64-{0}.zip" -f $version)

$runtimeFiles = @(
	'icudtl.dat',
	'chrome_100_percent.pak',
	'chrome_200_percent.pak',
	'd3dcompiler_47.dll',
	'dxcompiler.dll',
	'dxil.dll',
	'ffmpeg.dll',
	'libEGL.dll',
	'libGLESv2.dll',
	'resources.pak',
	'vk_swiftshader.dll',
	'vulkan-1.dll'
)

Write-Host 'Building wavesrv backend for Windows...'
task build:server:windows

Write-Host 'Building wsh binaries...'
task build:wsh

Write-Host 'Building production frontend/main bundles...'
npm run build:prod

Write-Host 'Creating unpacked Windows app...'
npm exec electron-builder -- -c electron-builder.config.cjs -p never --win dir

if (-not (Test-Path $winUnpackedDir)) {
	throw "Expected output directory not found: $winUnpackedDir"
}

Write-Host 'Ensuring Electron runtime files are present...'
foreach ($file in $runtimeFiles) {
	$src = Join-Path $electronDist $file
	$dst = Join-Path $winUnpackedDir $file
	if (-not (Test-Path $src)) {
		throw "Missing runtime file in electron distribution: $src"
	}
	Copy-Item $src $dst -Force
}

if (Test-Path $zipPath) {
	Remove-Item $zipPath -Force
}

Write-Host 'Creating ZIP archive...'
Push-Location $makeDir
try {
	Compress-Archive -Path 'win-unpacked' -DestinationPath $zipPath -Force
} finally {
	Pop-Location
}

Write-Host 'Verifying ZIP archive...'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
try {
	$waveExeEntry = $archive.Entries | Where-Object { $_.FullName -eq 'win-unpacked/Wave.exe' -or $_.FullName -eq 'win-unpacked\Wave.exe' } | Select-Object -First 1
	if ($null -eq $waveExeEntry) {
		throw 'ZIP verification failed: Wave.exe missing from archive'
	}
	Write-Host ("ZIP verified: {0} entries" -f $archive.Entries.Count)
} finally {
	$archive.Dispose()
}

$zipInfo = Get-Item $zipPath
Write-Host ''
Write-Host 'Build complete.'
Write-Host ("Wave.exe: {0}" -f (Join-Path $winUnpackedDir 'Wave.exe'))
Write-Host ("ZIP:      {0}" -f $zipPath)
Write-Host ("ZIP size: {0} MB" -f [Math]::Round($zipInfo.Length / 1MB, 2))