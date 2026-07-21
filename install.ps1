# BanyanCode PowerShell Installer
#
# Usage:
#   irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex
#
#   # or with pinned version:
#   $env:VERSION = "26.07.1"
#   irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex
#
#   # or from a local build (no download):
#   ./install.ps1 -Binary C:\path\to\banyancode.exe

[CmdletBinding()]
param(
    [string]$Version = $env:VERSION,
    [string]$Binary,
    [string]$Repo = "EkagraAgarwal/BanyanCode",
    [switch]$NoModifyPath
)

$ErrorActionPreference = "Stop"
$APP = "banyancode"
$INSTALL_DIR = Join-Path $env:LOCALAPPDATA "$APP\bin"

function Print-Message {
    param([string]$Level, [string]$Message, [string]$Color)
    $ts = Get-Date -Format "HH:mm:ss"
    Write-Host "[$ts] " -NoNewline -ForegroundColor DarkGray
    if ($Color) {
        Write-Host $Message -ForegroundColor $Color
    } else {
        Write-Host $Message
    }
}

function Show-Usage {
    @"
BanyanCode PowerShell Installer

Usage:
    irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex

    # Pin a version:
    `$env:VERSION = "26.07.1"
    irm https://raw.githubusercontent.com/EkagraAgarwal/BanyanCode/main/install.ps1 | iex

    # Install from a local binary:
    ./install.ps1 -Binary C:\path\to\banyancode.exe

    # Don't modify user PATH:
    ./install.ps1 -NoModifyPath
"@
}

if ($args -contains "-h" -or $args -contains "--help") {
    Show-Usage
    exit 0
}

Print-Message info "BanyanCode Installer" "Cyan"
Print-Message info "Repo: $Repo / Install dir: $INSTALL_DIR" "DarkGray"

# Resolve target arch + asset
$arch = if ([Environment]::Is64BitOperatingSystem) {
    [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLower()
} else { "x86" }

# Normalize values PowerShell may emit
$arch = switch -Regex ($arch) {
    '^arm'   { 'arm64' }
    '^x(64|86)' { 'x64' }
    default { 'x64' }
}

# AVX2 / baseline detection via Win32
function Test-Avx2 {
    try {
        $sig = @'
[DllImport("kernel32.dll")]
public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);
'@
        $k = Add-Type -MemberDefinition $sig -Name "K32$([Guid]::NewGuid().ToString('N'))" -Namespace "Win32" -PassThru
        return $k::IsProcessorFeaturePresent(40)
    } catch {
        return $false
    }
}

$needsBaseline = ($arch -eq "x64") -and -not (Test-Avx2)
if ($needsBaseline) {
    $target = "windows-x64-baseline"
} else {
    $target = "windows-$arch"
}

$filename = "$APP-$target.zip"
$downloadUrl = if ($Version) {
    "https://github.com/$Repo/releases/download/v$Version/$filename"
} else {
    "https://github.com/$Repo/releases/latest/download/$filename"
}

Print-Message info "Target: $filename" "DarkGray"

if ($Binary) {
    Print-Message info "Installing from local binary: $Binary" "Yellow"
    if (-not (Test-Path $Binary)) {
        Print-Message error "Binary not found: $Binary" "Red"
        exit 1
    }
    $specificVersion = "local"
} else {
    Print-Message info "Downloading from $downloadUrl" "Cyan"

    $tmp = New-TemporaryFile
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $wc = New-Object System.Net.WebClient
        $wc.DownloadFile($downloadUrl, $tmp.FullName)
    } catch {
        Print-Message error "Download failed: $_" "Red"
        exit 1
    }

    Print-Message info "Extracting..." "Cyan"
    $extractDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP "$APP-install-$PID") -Force
    Expand-Archive -Path $tmp.FullName -DestinationPath $extractDir.FullName -Force
    $binaryPath = Join-Path $extractDir.FullName "$APP.exe"
    if (-not (Test-Path $binaryPath)) {
        Print-Message error "Expected binary not found at $binaryPath" "Red"
        exit 1
    }
    $Binary = $binaryPath
}

# Install into $INSTALL_DIR
New-Item -ItemType Directory -Path $INSTALL_DIR -Force | Out-Null
Copy-Item -Path $Binary -Destination (Join-Path $INSTALL_DIR "$APP.exe") -Force

# Verify
& "$INSTALL_DIR\$APP.exe" --version | Out-Null
Print-Message info "Installed $APP $specificVersion to $INSTALL_DIR\$APP.exe" "Green"

# PATH modification
if (-not $NoModifyPath) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($current -notlike "*$INSTALL_DIR*") {
        Print-Message info "Adding $INSTALL_DIR to user PATH..." "Yellow"
        [Environment]::SetEnvironmentVariable(
            "Path",
            "$current;$INSTALL_DIR",
            "User"
        )
        # Refresh current shell PATH
        $env:Path = [Environment]::GetEnvironmentVariable("Path", "User") + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine")
        Print-Message info "PATH updated. Restart your shell for changes to take effect." "Yellow"
    }
}

# Banner
Write-Host ""
Write-Host "  BanyanCode installed successfully." -ForegroundColor Green
Write-Host "  Get started: open a new PowerShell, cd to a project, run 'banyancode'." -ForegroundColor Cyan
Write-Host "  Docs: https://github.com/$Repo/blob/main/packages/docs/src/content/docs/banyancode-install.mdx" -ForegroundColor DarkGray
Write-Host ""
