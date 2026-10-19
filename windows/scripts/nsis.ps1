# Shared by CI installation and local packaging. A package-manager exit code or
# an existing file alone does not establish that the NSIS compiler is usable.
function Find-NsisCompiler([switch]$Required) {
  $candidates = @($env:NOCTURNE_MAKENSIS)
  $command = Get-Command makensis.exe -CommandType Application -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }

  $chocolateyRoots = @($env:ChocolateyInstall, "C:\ProgramData\chocolatey") |
    Where-Object { $_ } | Select-Object -Unique
  foreach ($root in $chocolateyRoots) {
    $candidates += Join-Path $root "bin\makensis.exe"
    $candidates += Join-Path $root "tools\NSIS\makensis.exe"
    # nsis.install may unpack a portable compiler under lib instead of adding
    # it to PATH or installing into Program Files.
    $packages = Get-ChildItem (Join-Path $root "lib") -Directory -Filter "nsis*" -ErrorAction SilentlyContinue
    foreach ($package in $packages) {
      $candidates += Get-ChildItem $package.FullName -Recurse -File -Filter "makensis.exe" -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    }
  }
  foreach ($root in @(${env:ProgramFiles(x86)}, $env:ProgramFiles, "C:\Program Files (x86)", "C:\Program Files", $env:ChocolateyToolsLocation, "C:\tools") |
    Where-Object { $_ } | Select-Object -Unique) {
    $candidates += Join-Path $root "NSIS\makensis.exe"
  }

  $candidates = @($candidates | Where-Object { $_ } | Select-Object -Unique)
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    try {
      $version = (& $candidate /VERSION 2>&1 | Out-String).Trim()
      $exitCode = $LASTEXITCODE
      if ($exitCode -eq 0 -and $version -match '^v?\d+\.\d+') {
        $verifiedPath = (Get-Item -LiteralPath $candidate).FullName
        Write-Host "Verified NSIS compiler: $verifiedPath ($version)"
        return $verifiedPath
      }
      Write-Warning "NSIS validation failed: '$candidate' /VERSION exited $exitCode; output: $version"
    } catch {
      Write-Warning "Could not execute NSIS compiler '$candidate': $_"
    }
  }

  Write-Host "No usable NSIS compiler found. Checked: $($candidates -join '; ')"
  if ($Required) {
    throw "Install NSIS with a working makensis.exe and set NOCTURNE_MAKENSIS to its full path. Each candidate must run /VERSION successfully. Chocolatey logs: C:\ProgramData\chocolatey\logs\chocolatey.log (or under ChocolateyInstall)."
  }
  return $null
}
