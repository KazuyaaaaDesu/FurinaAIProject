$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

$statusLines = @(& git -C $root status --porcelain --untracked-files=all)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to read Git status."
}

$allowedRoots = @(
    "apps/",
    "core/",
    "docs/",
    "discord-bot/",
    "Fufuu.Wpf/",
    "omnivoice/",
    "scripts/",
    "server/",
    "services/",
    "shared/",
    "skills/",
    "src/",
    "tests/"
)
$allowedRootFiles = @(
    "PetStage.html",
    "eslint.config.js",
    "index.html",
    "package-lock.json",
    "package.json",
    "README.md",
    "tsconfig.app.json",
    "tsconfig.json",
    "tsconfig.node.json",
    "vite.config.ts"
)
$unexpectedPaths = @()
$conversationModificationFound = $false
$memoryModificationFound = $false

foreach ($line in $statusLines) {
    if ($line.Length -lt 4) {
        continue
    }

    $reportedPath = $line.Substring(3).Trim('"')
    $paths = @($reportedPath -split " -> ")
    $allowed = $true
    foreach ($relativePath in $paths) {
        if ($relativePath -eq "data/conversations.json") {
            $conversationModificationFound = $true
            continue
        }
        if ($relativePath -eq "data/memory.json") {
            $memoryModificationFound = $true
            $allowed = $false
            continue
        }
        if (($allowedRootFiles -contains $relativePath) -or
            ($allowedRoots | Where-Object { $relativePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) {
            continue
        }
        $allowed = $false
    }
    if ($allowed) {
        continue
    }
    $unexpectedPaths += $reportedPath
}

if (-not $conversationModificationFound) {
    throw "The pre-existing Git modification for data/conversations.json is no longer present."
}
if ($memoryModificationFound) {
    throw "Git reports a change to protected data/memory.json."
}
if ($unexpectedPaths.Count -gt 0) {
    throw "Unexpected existing-path changes detected: $($unexpectedPaths -join ', ')"
}

$agentApiListeners = @(Get-NetTCPConnection -State Listen -LocalPort 4319 -ErrorAction SilentlyContinue)
if ($agentApiListeners.Count -gt 0) {
    throw "Port 4319 is already listening; the new agent API cannot bind safely."
}

Write-Output "Protected data contents were not read."
Write-Output "Existing data/conversations.json working-tree modification is still present."
Write-Output "No unexpected existing-path changes are reported by Git."
Write-Output "Port 4319 is available."

foreach ($port in @(4317, 8765)) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        Write-Output "Legacy service port $port is listening."
    } else {
        Write-Output "Legacy service port $port is available."
    }
}
