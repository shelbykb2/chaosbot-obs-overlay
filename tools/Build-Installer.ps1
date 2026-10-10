[CmdletBinding()]
param(
    [string] $Version,
    [switch] $SkipNativeBuild,
    [switch] $SkipUiBuild,
    [switch] $SkipRuntimePublish,
    [switch] $Sign
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$packageRoot = Join-Path $repo 'package'

function Invoke-Native {
    param([Parameter(Mandatory)][string] $FilePath, [Parameter(Mandatory)][string[]] $ArgumentList, [string] $WorkingDirectory = $repo)
    Write-Host "> $FilePath $($ArgumentList -join ' ')"
    Push-Location -LiteralPath $WorkingDirectory
    try {
        & $FilePath @ArgumentList
        if ($LASTEXITCODE -ne 0) { throw "Command failed with exit code $LASTEXITCODE`: $FilePath" }
    }
    finally { Pop-Location }
}

function Clear-PackageOutput {
    param([Parameter(Mandatory)][string] $Name)
    if ($Name -notin @('runtime', 'installer-stage', 'installer-output')) { throw "Refusing to clear unexpected package output '$Name'." }
    $target = [IO.Path]::GetFullPath((Join-Path $packageRoot $Name))
    $expectedParent = [IO.Path]::GetFullPath($packageRoot)
    if ([IO.Path]::GetDirectoryName($target) -ne $expectedParent -or $target -eq [IO.Path]::GetPathRoot($target)) {
        throw "Refusing to clear a path outside the package output directory: $target"
    }
    if (Test-Path -LiteralPath $target) {
        $item = Get-Item -LiteralPath $target -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing to clear a reparse point: $target" }
        Remove-Item -LiteralPath $target -Recurse -Force
    }
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    return $target
}

function Get-CMake {
    $command = Get-Command cmake.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $installPath = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
        if ($installPath) {
            $bundled = Join-Path $installPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
            if (Test-Path -LiteralPath $bundled) { return $bundled }
        }
    }
    $vsRoots = @((Join-Path $env:ProgramFiles 'Microsoft Visual Studio'), (Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio'))
    foreach ($vsRoot in $vsRoots) {
        if (Test-Path -LiteralPath $vsRoot) {
            $candidate = Get-ChildItem -LiteralPath $vsRoot -Filter cmake.exe -File -Recurse -ErrorAction SilentlyContinue |
                Where-Object { $_.FullName -match '\\Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\CMake\\bin\\cmake\.exe$' } |
                Select-Object -First 1
            if ($candidate) { return $candidate.FullName }
        }
    }
    throw 'CMake was not found. Install Visual Studio 2022 or later with the C++ workload and bundled CMake.'
}

function Get-VisualStudioGenerator {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path -LiteralPath $vswhere) {
        $version = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationVersion | Select-Object -First 1)
        if ($version -match '^18\.') { return 'Visual Studio 18 2026' }
        if ($version -match '^17\.') { return 'Visual Studio 17 2022' }
    }
    throw 'A Visual Studio 2022 or later C++ installation was not found.'
}

function Get-InnoCompiler {
    $command = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $packageRoot 'inno-setup6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe')
    )
    foreach ($candidate in $candidates) { if (Test-Path -LiteralPath $candidate) { return $candidate } }
    throw 'Inno Setup 6 was not found. Install it from https://jrsoftware.org/isinfo.php before building the installer.'
}

if (-not $Version) {
    $spec = Get-Content (Join-Path $repo 'buildspec.json') -Raw | ConvertFrom-Json
    $Version = [string]$spec.version
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Expected a stable x.y.z version, got '$Version'." }

$runtimeOutput = if ($SkipRuntimePublish) {
    Join-Path $packageRoot 'runtime'
} else {
    Clear-PackageOutput 'runtime'
}
if (-not $SkipNativeBuild) {
    $cmake = Get-CMake
    $generator = Get-VisualStudioGenerator
    Invoke-Native $cmake @('-S', $repo, '-B', (Join-Path $repo 'build_x64'), '-G', $generator, '-A', 'x64', '-DENABLE_QT=ON', '-DENABLE_FRONTEND_API=ON')
    Invoke-Native $cmake @('--build', (Join-Path $repo 'build_x64'), '--config', 'Release', '--parallel')
}

$dll = Join-Path $repo 'build_x64\Release\chaosbot-overlay.dll'
if (-not (Test-Path -LiteralPath $dll -PathType Leaf)) { throw "Native plugin DLL is missing: $dll" }

$ui = Join-Path $repo 'overlay-ui'
if (-not $SkipUiBuild) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    Invoke-Native $npm @('ci') $ui
    Invoke-Native $npm @('run', 'build') $ui
}
$site = Join-Path $repo 'data\site'
if (-not (Test-Path -LiteralPath (Join-Path $site 'editor\index.html') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $site 'scene\index.html') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $site 'spotify\index.html') -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $site 'ui') -PathType Container)) {
    throw "UI build did not produce data/site with the overlay, editor, scene, Spotify, and UI assets: $site"
}

if (-not $SkipRuntimePublish) {
    Invoke-Native 'dotnet.exe' @('publish', (Join-Path $repo 'runtime\OverlayRuntime.csproj'), '-c', 'Release', '-r', 'win-x64', '--self-contained', 'true', '-p:PublishSingleFile=false', '-o', $runtimeOutput)
}
foreach ($requiredRuntimeFile in @('ChaosBot.Overlay.Runtime.exe', 'ChaosBot.Overlay.Runtime.dll', 'ChaosBot.Overlay.Runtime.deps.json', 'ChaosBot.Overlay.Runtime.runtimeconfig.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $runtimeOutput $requiredRuntimeFile) -PathType Leaf)) {
        throw "The self-contained runtime publish is missing $requiredRuntimeFile."
    }
}

if ($Sign) {
    $signer = Join-Path $PSScriptRoot 'Sign-Authenticode.ps1'
    if (-not (Test-Path -LiteralPath $signer -PathType Leaf)) { throw "Signing was requested but the signing helper is missing: $signer" }
    & $signer -Files @($dll, (Join-Path $runtimeOutput 'ChaosBot.Overlay.Runtime.exe'), (Join-Path $runtimeOutput 'ChaosBot.Overlay.Runtime.dll'))
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Authenticode signing failed with exit code $LASTEXITCODE." }
}

$stage = Clear-PackageOutput 'installer-stage'
$output = Clear-PackageOutput 'installer-output'
$pluginBinary = Join-Path $stage 'bin\64bit'
$pluginData = Join-Path $stage 'data'
New-Item -ItemType Directory -Path $pluginBinary, (Join-Path $pluginData 'locale'), (Join-Path $pluginData 'site'), (Join-Path $pluginData 'runtime') -Force | Out-Null
Copy-Item -LiteralPath $dll -Destination (Join-Path $pluginBinary 'chaosbot-overlay.dll')
Copy-Item -Path (Join-Path $repo 'data\locale\*') -Destination (Join-Path $pluginData 'locale') -Recurse -Force
Copy-Item -Path (Join-Path $site '*') -Destination (Join-Path $pluginData 'site') -Recurse -Force
Copy-Item -Path (Join-Path $runtimeOutput '*') -Destination (Join-Path $pluginData 'runtime') -Recurse -Force

$iscc = Get-InnoCompiler
$iss = Join-Path $repo 'installer\ChaosBotOverlay.iss'
Invoke-Native $iscc @('/Qp', "/DAppVersion=$Version", "/O$output", $iss)
$installer = Join-Path $output 'ChaosBot-OBS-Overlay-Setup.exe'
if (-not (Test-Path -LiteralPath $installer -PathType Leaf) -or (Get-Item -LiteralPath $installer).Length -lt 1000000) {
    throw 'Inno Setup did not produce the expected installer executable.'
}
if ($Sign) {
    & (Join-Path $PSScriptRoot 'Sign-Authenticode.ps1') -Files @($installer)
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) { throw "Installer signing failed with exit code $LASTEXITCODE." }
}
Write-Host "Installer ready: $installer"
