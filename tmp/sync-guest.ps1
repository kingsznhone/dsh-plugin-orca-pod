# Sync the committed tree to the Hyper-V Linux guest and refresh its node_modules.
#
# Cross-machine checks (join, A2A, blobs) only mean something when both sides run
# the same code. This copies `HEAD` (not the dirty working tree) through an
# archive, so the guest never gets a half-finished edit. Requires `git`, `scp` and
# `ssh` on PATH and root access to the guest (see docs/09-implementation.md).
#
# Example: .\scripts\sync-guest.ps1 -Guest 192.168.86.252 -User root
[CmdletBinding()]
param(
  [string]$Guest = "192.168.86.252",
  [string]$User = "root",
  [string]$RemotePath = "/root/orca-pod",
  [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"

$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $repo ".git"))) {
  throw "not a git checkout: $repo"
}

$archive = Join-Path $env:TEMP ("orca-pod-sync-" + [guid]::NewGuid().ToString("N") + ".tar.gz")
try {
  git -C $repo archive --format=tar.gz -o $archive HEAD
  if ($LASTEXITCODE -ne 0) { throw "git archive failed" }

  $target = "$User@$Guest"
  scp -q $archive "${target}:/tmp/orca-pod-sync.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw "scp failed" }

  # The guest installs Node through nvm; a login shell puts npm on PATH.
  $remote = "mkdir -p $RemotePath && tar -xzf /tmp/orca-pod-sync.tar.gz -C $RemotePath && rm -f /tmp/orca-pod-sync.tar.gz"
  if (-not $SkipInstall) {
    $remote += " && cd $RemotePath && npm install --no-audit --no-fund"
  }
  ssh $target "bash -lc '$remote'"
  if ($LASTEXITCODE -ne 0) { throw "remote update failed" }

  $rev = (git -C $repo rev-parse --short HEAD).Trim()
  Write-Host "synced $rev to ${target}:$RemotePath"
}
finally {
  if (Test-Path $archive) { Remove-Item $archive -Force }
}
