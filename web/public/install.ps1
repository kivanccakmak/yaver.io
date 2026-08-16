# Yaver CLI installer for Windows
# Usage: irm https://yaver.io/install.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "yaver-io/yaver.io"
$installDir = "$env:LOCALAPPDATA\yaver"

Write-Host "Installing yaver..." -ForegroundColor Cyan

# Get latest semver release
$releases = Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=100"
$release = $releases | Where-Object { $_.tag_name -match '^v\d' -and -not $_.draft -and -not $_.prerelease } | Select-Object -First 1
if (-not $release) {
    throw "Could not determine latest Yaver release"
}
$latest = $release.tag_name
Write-Host "Latest version: $latest"

$runtimeArch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
$goArch = switch ($runtimeArch) {
    "x64" { "amd64" }
    "arm64" { "arm64" }
    default { throw "Yaver does not publish a native Windows agent for architecture '$runtimeArch'. Use WSL or a supported x64/arm64 Windows machine." }
}
$assetName = "yaver-windows-$goArch.exe"
$asset = $release.assets | Where-Object { $_.name -eq $assetName } | Select-Object -First 1
if (-not $asset) {
    throw "Release $latest has no $assetName. This Windows architecture is not available in that release; no fallback binary was installed."
}
$checksumAsset = $release.assets | Where-Object { $_.name -eq "checksums.txt" } | Select-Object -First 1
if (-not $checksumAsset) {
    throw "Release $latest has no checksums.txt. Refusing to install an unverified executable."
}
Write-Host "Downloading $($asset.browser_download_url)..."

# Create install directory
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$dest = "$installDir\yaver.exe"
$tempDest = Join-Path $env:TEMP ("yaver-agent-" + [guid]::NewGuid().ToString("N") + ".exe")
$tempChecksums = Join-Path $env:TEMP ("yaver-checksums-" + [guid]::NewGuid().ToString("N") + ".txt")
try {
    # Download to a temporary path. A failed verification leaves any existing
    # working installation untouched.
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tempDest
    Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $tempChecksums

    $expectedHash = $null
    foreach ($line in Get-Content $tempChecksums) {
        $parts = $line.Trim() -split '\s+', 2
        if ($parts.Count -eq 2 -and $parts[1].TrimStart('*') -eq $assetName) {
            $expectedHash = $parts[0].ToLowerInvariant()
            break
        }
    }
    if (-not $expectedHash -or $expectedHash -notmatch '^[a-f0-9]{64}$') {
        throw "checksums.txt does not contain a valid SHA-256 entry for $assetName."
    }
    $actualHash = (Get-FileHash -Algorithm SHA256 -Path $tempDest).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw "SHA-256 verification failed for $assetName. Expected $expectedHash but downloaded $actualHash."
    }

    # The release checksum protects artifact identity; Authenticode proves the
    # executable was signed by a Windows-trusted publisher. Both are required.
    $signature = Get-AuthenticodeSignature -FilePath $tempDest
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "Authenticode verification failed for $assetName ($($signature.Status): $($signature.StatusMessage)). Refusing to install."
    }
    if ($signature.SignerCertificate.Subject -notmatch '(?i)simkab') {
        throw "Authenticode publisher mismatch for $assetName ($($signature.SignerCertificate.Subject)). Expected the Simkab signing identity. Refusing to install."
    }

    Move-Item -Force -Path $tempDest -Destination $dest
} finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $tempDest
    Remove-Item -Force -ErrorAction SilentlyContinue $tempChecksums
}

# Add to PATH if not already there
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$installDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$currentPath;$installDir", "User")
    Write-Host "Added $installDir to PATH" -ForegroundColor Green
}

Write-Host ""
Write-Host "yaver installed to $dest" -ForegroundColor Green
Write-Host ""
& $dest version
Write-Host ""
Write-Host "Get started:" -ForegroundColor Cyan
Write-Host "  yaver auth    Sign in & start the agent"
Write-Host ""
Write-Host "Restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
