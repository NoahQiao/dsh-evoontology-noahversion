<#
.SYNOPSIS
  Re-sync the vendored EvoOntology core and skills from an upstream checkout.

.DESCRIPTION
  Copies the zero-dependency Python package and the three SKILL.md bundles from
  the upstream ruc-datalab/EvoOntology checkout, then rewrites upstream MCP tool
  names to the names DSH registers for them (`mcp__evo__<tool>`).

  The rewrite is idempotent: an already-prefixed name is left untouched, so the
  script can run repeatedly against a dirty tree.

.PARAMETER Upstream
  Path to the upstream checkout root (the directory holding pyproject.toml).

.EXAMPLE
  pwsh -File scripts/sync-from-upstream.ps1
  pwsh -File scripts/sync-from-upstream.ps1 -Upstream D:\dsworkspace\evoontology
#>
[CmdletBinding()]
param(
    [string] $Upstream = 'D:\dsworkspace\evoontology'
)

$ErrorActionPreference = 'Stop'

$RepoRoot    = Split-Path -Parent $PSScriptRoot
$PythonDest  = Join-Path $RepoRoot 'python'
$SkillsDest  = Join-Path $RepoRoot 'skills'
$PySrc       = Join-Path $Upstream 'evoontology'
$SkillsSrc   = Join-Path $Upstream 'plugins\claude-code\skills'

if (-not (Test-Path (Join-Path $Upstream 'pyproject.toml'))) {
    throw "Not an EvoOntology checkout: $Upstream"
}
if (-not (Test-Path $PySrc))       { throw "Missing package: $PySrc" }
if (-not (Test-Path $SkillsSrc))   { throw "Missing skills: $SkillsSrc" }

# --- 1. vendored Python package ------------------------------------------------
if (Test-Path (Join-Path $PythonDest 'evoontology')) {
    Remove-Item -Recurse -Force (Join-Path $PythonDest 'evoontology')
}
New-Item -ItemType Directory -Force -Path $PythonDest | Out-Null

$copied = 0
Get-ChildItem -Recurse -File $PySrc | Where-Object {
    $_.FullName -notmatch '__pycache__' -and $_.Extension -ne '.pyc'
} | ForEach-Object {
    $rel    = $_.FullName.Substring($PySrc.Length).TrimStart('\')
    $target = Join-Path (Join-Path $PythonDest 'evoontology') $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
    $script:copied++
}
Write-Host "python: copied $copied files from $PySrc"

# --- 2. skills -----------------------------------------------------------------
$skillNames = @('build-ontology', 'evolve-ontology', 'explore-ontology')
if (Test-Path $SkillsDest) {
    foreach ($n in $skillNames) {
        if (Test-Path (Join-Path $SkillsDest $n)) {
            Remove-Item -Recurse -Force (Join-Path $SkillsDest $n)
        }
    }
}
foreach ($n in $skillNames) {
    $src = Join-Path $SkillsSrc $n
    if (-not (Test-Path $src)) { throw "Missing upstream skill: $src" }
    Copy-Item -Recurse -Force -LiteralPath $src -Destination (Join-Path $SkillsDest $n)
}

# --- 3. rewrite upstream tool names to the DSH-registered names ----------------
# serverName in cordis.patch.yml is `evo`, so DSH registers mcp__evo__<tool>.
$tools = @(
    'browse_semantics', 'resolve_semantics', 'validate_semantics', 'visualize_ontology',
    'evolution_status', 'list_versions', 'save_version', 'set_active_version',
    'start_evolution_run', 'resume_evolution_run', 'evolution_run_status',
    'begin_evolution_round', 'record_evolution_round', 'record_evolution_evaluation',
    'confirm_trajectory_sources', 'accept_evolution', 'mark_evolution_incomplete',
    'extend_evolution_budget', 'finalize_evolution_run', 'publish_ontology_build',
    'configure_ontology_project', 'prepare_ontology_workload', 'ontology_workflow_status',
    'start_ontology_task', 'record_ontology_task_event', 'finish_ontology_task',
    'execute_ontology_query', 'resolve_ontology_task', 'annotate_ontology_version'
)

# Longest first so a short name never eats a longer one's prefix.
$ordered = $tools | Sort-Object -Property Length -Descending

$changed = 0
$rewrites = 0
Get-ChildItem -Recurse -File -Filter *.md $SkillsDest | ForEach-Object {
    $text  = Get-Content -LiteralPath $_.FullName -Raw
    $orig  = $text
    foreach ($t in $ordered) {
        $pattern = '(?<![A-Za-z0-9_])' + [regex]::Escape($t) + '(?![A-Za-z0-9_])'
        $text = [regex]::Replace($text, $pattern, { param($m) "mcp__evo__$($m.Value)" })
    }
    # The upstream text calls the server `evo-semantic`; this bundle registers it as `evo`.
    $text = $text.Replace('`evo-semantic` MCP tool', '`evo` MCP tool')
    $text = $text.Replace('`evo-semantic` MCP tools', '`evo` MCP tools')
    $text = $text.Replace('`evo-semantic` MCP', '`evo` MCP server')

    if ($text -ne $orig) {
        $rewrites += ([regex]::Matches($text, 'mcp__evo__')).Count - ([regex]::Matches($orig, 'mcp__evo__')).Count
        [System.IO.File]::WriteAllText($_.FullName, $text, (New-Object System.Text.UTF8Encoding($false)))
        $changed++
    }
}
Write-Host "skills: copied $($skillNames.Count), rewrote $changed files (+$rewrites tool references)"

# --- 4. provenance -------------------------------------------------------------
$version = (Select-String -Path (Join-Path $Upstream 'pyproject.toml') -Pattern '^\s*version\s*=\s*"([^"]+)"' |
    Select-Object -First 1).Matches.Groups[1].Value
if (-not $version) { $version = 'unknown' }
$provenance = @(
    "upstream: ruc-datalab/EvoOntology"
    "version: $version"
    "source: $Upstream"
    "synced: $(Get-Date -Format 'yyyy-MM-ddTHH:mm:sszzz')"
) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $PythonDest 'UPSTREAM.txt'), $provenance + "`n",
    (New-Object System.Text.UTF8Encoding($false)))
Write-Host "provenance: upstream version $version"
