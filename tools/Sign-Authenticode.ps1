<#
.SYNOPSIS
Authenticode-signs files with Azure Artifact Signing (SignTool + dlib).

.DESCRIPTION
Used by build-installer.ps1 -Sign. Authenticates with DefaultAzureCredential
(Azure CLI after `az login` locally, azure/login in CI). Downloads SignTool and
the Artifact Signing dlib into tools/.artifact-signing on first run (gitignored).

Account is West US 2 / chaosbot / chaosbot-public unless overridden by
CHAOSBOT_SIGNING_ENDPOINT, CHAOSBOT_SIGNING_ACCOUNT, CHAOSBOT_SIGNING_PROFILE.

-VpkTemplate signs nothing. It prepares SignTool, the dlib and metadata.json, then returns a
`vpk pack --signTemplate` command, so vpk signs every unsigned file it packs: our DLLs,
unsigned third-party DLLs, Update.exe and Setup.exe. vpk skips files that already carry a
trusted signature (the .NET and Windows App SDK runtime), so only those cost a signature.
#>
param(
    [string[]]$Files = @(),
    [switch]$VpkTemplate
)

$ErrorActionPreference = "Stop"

$azureCliFolder = Join-Path $env:ProgramFiles 'Microsoft SDKs\Azure\CLI2\wbin'
if (-not (Get-Command az -ErrorAction SilentlyContinue) -and (Test-Path -LiteralPath (Join-Path $azureCliFolder 'az.cmd'))) {
    $env:PATH = $azureCliFolder + ';' + $env:PATH
}

$endpoint = if ($env:CHAOSBOT_SIGNING_ENDPOINT) { $env:CHAOSBOT_SIGNING_ENDPOINT } else { "https://wus2.codesigning.azure.net/" }
$account = if ($env:CHAOSBOT_SIGNING_ACCOUNT) { $env:CHAOSBOT_SIGNING_ACCOUNT } else { "chaosbot" }
$profile = if ($env:CHAOSBOT_SIGNING_PROFILE) { $env:CHAOSBOT_SIGNING_PROFILE } else { "chaosbot-public" }

$cache = Join-Path $PSScriptRoot ".artifact-signing"
$buildToolsVersion = "10.0.26100.4654"
$dlibVersion = "1.0.128"

function Get-NugetPackage {
    param([string]$Name, [string]$Version)
    $dest = Join-Path $cache "$Name.$Version"
    if (Test-Path -LiteralPath $dest) { return $dest }
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $zip = Join-Path $cache "$Name.$Version.zip"
    $url = "https://www.nuget.org/api/v2/package/$Name/$Version"
    Write-Host "Downloading $Name $Version..."
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
    Remove-Item -LiteralPath $zip -Force
    return $dest
}

$sdkRoot = Get-NugetPackage -Name "Microsoft.Windows.SDK.BuildTools" -Version $buildToolsVersion
$dlibRoot = Get-NugetPackage -Name "Microsoft.ArtifactSigning.Client" -Version $dlibVersion

$signtool = Get-ChildItem -LiteralPath $sdkRoot -Recurse -Filter "signtool.exe" -File |
    Where-Object { $_.FullName -match '[\\/]x64[\\/]signtool\.exe$' } |
    Select-Object -First 1
if (-not $signtool) { throw "signtool.exe x64 not found under $sdkRoot" }

$dlib = Get-ChildItem -LiteralPath $dlibRoot -Recurse -Filter "Azure.CodeSigning.Dlib.dll" -File |
    Where-Object { $_.FullName -match '[\\/]x64[\\/]' } |
    Select-Object -First 1
if (-not $dlib) { throw "Azure.CodeSigning.Dlib.dll x64 not found under $dlibRoot" }

$metadataPath = Join-Path $cache "metadata.json"
$correlation = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { $env:COMPUTERNAME }
$metadata = [ordered]@{
    Endpoint                = $endpoint
    CodeSigningAccountName  = $account
    CertificateProfileName  = $profile
    CorrelationId           = "$correlation"
    ExcludeCredentials      = @(
        "ManagedIdentityCredential"
        "WorkloadIdentityCredential"
        "SharedTokenCacheCredential"
        "VisualStudioCredential"
        "VisualStudioCodeCredential"
        "AzurePowerShellCredential"
        "AzureDeveloperCliCredential"
        "InteractiveBrowserCredential"
    )
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath $metadataPath -Encoding utf8

$signArgs = "sign /fd SHA256 /tr `"http://timestamp.acs.microsoft.com`" /td SHA256 " +
    "/dlib `"$($dlib.FullName)`" /dmdf `"$metadataPath`""

if ($VpkTemplate) {
    # vpk runs this through cmd.exe and replaces {{file...}} with a batch of quoted paths.
    return "`"$($signtool.FullName)`" $signArgs {{file...}}"
}

if ($Files.Count -eq 0) { throw "Pass -Files, or -VpkTemplate." }

$existing = @()
foreach ($path in $Files) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Nothing to sign: $path" }
    $existing += (Resolve-Path -LiteralPath $path).Path
}

Write-Host "Artifact Signing: $account / $profile ($endpoint)"
foreach ($path in $existing) {
    Write-Host "  Signing $path"
    & $signtool.FullName sign /fd SHA256 /tr "http://timestamp.acs.microsoft.com" /td SHA256 `
        /dlib $dlib.FullName /dmdf $metadataPath $path
    # Keep in step with $signArgs above, which vpk uses.
    if ($LASTEXITCODE -ne 0) { throw "SignTool failed for $path (exit $LASTEXITCODE)." }
    $sig = Get-AuthenticodeSignature -LiteralPath $path
    if ($sig.Status -ne "Valid") {
        throw "Signature status for $path is $($sig.Status): $($sig.StatusMessage)"
    }
    if (-not $sig.TimeStamperCertificate) {
        throw "Signed $path but the signature has no RFC 3161 timestamp."
    }
    Write-Host "  Timestamped by $($sig.TimeStamperCertificate.Subject)"
}
