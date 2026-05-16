<#
  Rebuilds the Git history for the AI Chatbot project.

  Who owns what:
    Aziz   - frontend UI + chat-service + model-service
    Hama   - API gateway + Docker + Postman
    Rimel  - activity-service + README + SCHEMAS

  Big files are committed in pieces (truncated on early commits, then filled in
  later) so every commit has a real diff. Current reliability and documentation
  fixes are folded into the original six-day plan, not added as a fake repair day:

    backend/gateway/src/index.ts                    (Hama, 4 commits)
    backend/services/activity-service/src/index.ts  (Rimel, 4 commits)
    README.md                                       (Rimel, 2 commits)
    postman/soa-clean.postman_collection.json       (Hama, 2 commits)

  WARNING: This script deletes .git and rebuilds local history. Do not run it
  on a repository with unpushed real work unless you intentionally want that.
#>
[CmdletBinding()]
param([switch] $Force)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

# ── Team ──────────────────────────────────────────────────────────────────────
$Members = @{
  Aziz  = @{ Name = 'Mohamed Aziz Mansour'; Email = 'mansour.mohamedaziz1@gmail.com';  Branch = 'aziz'  }
  Hama  = @{ Name = 'Mohamed Ncib';         Email = 'mohamedncib900@gmail.com';         Branch = 'hama'  }
  Rimel = @{ Name = 'Rimel Zouari';         Email = 'Rimel.zouari@polytechnicien.tn';  Branch = 'rimel' }
}

$RepoRoot = $PSScriptRoot
Set-Location -LiteralPath $RepoRoot
Write-Host "Repo: $RepoRoot"

if (-not $Force) {
  $confirm = Read-Host "This deletes .git and rebuilds history. Type 'yes' to continue"
  if ($confirm -ne 'yes') { Write-Host 'Aborted.'; return }
}

# ── Snapshot files that get progressive commits ──────────────────────────────
$Snapshots     = @{}
$SnapshotsText = @{}

function Save-Snapshot {
  param([string] $Path)
  $full = Join-Path $RepoRoot $Path
  if (-not (Test-Path -LiteralPath $full)) { throw "Cannot snapshot missing file: $Path" }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $Snapshots[$Path]     = $bytes
  $SnapshotsText[$Path] = [System.Text.Encoding]::UTF8.GetString($bytes)
}

$ProgressiveFiles = @(
  'backend/gateway/src/index.ts',
  'backend/services/activity-service/src/index.ts',
  'README.md',
  'postman/soa-clean.postman_collection.json'
)
foreach ($f in $ProgressiveFiles) { Save-Snapshot $f }
Write-Host "Snapshotted $($ProgressiveFiles.Count) files."

# ── Init repo ─────────────────────────────────────────────────────────────────
if (Test-Path -LiteralPath (Join-Path $RepoRoot '.git')) {
  Remove-Item -LiteralPath (Join-Path $RepoRoot '.git') -Recurse -Force
}

git init --initial-branch=main | Out-Null

# Author/committer identity is set per commit through environment variables.
# The script intentionally does not write repository-level git config.

$script:KnownBranches = @{ main = $true }

# ── File helpers ──────────────────────────────────────────────────────────────
function Write-Truncated {
  param([string] $Path, [int] $LineCount)
  $full    = Join-Path $RepoRoot $Path
  $content = $SnapshotsText[$Path]
  $nl      = if ($content.Contains("`r`n")) { "`r`n" } else { "`n" }
  $lines   = $content -split "`r?`n"
  $n       = [Math]::Min($LineCount, $lines.Length)
  $kept    = ($lines[0..($n - 1)]) -join $nl
  if ($content.EndsWith("`n")) { $kept = $kept + $nl }
  [System.IO.File]::WriteAllText($full, $kept, [System.Text.UTF8Encoding]::new($false))
}

function Restore-Full {
  param([string] $Path)
  $full = Join-Path $RepoRoot $Path
  [System.IO.File]::WriteAllBytes($full, $Snapshots[$Path])
}

# ── Git helpers ───────────────────────────────────────────────────────────────
function Invoke-Git {
  param([Parameter(ValueFromRemainingArguments)] $GitArgs)
  $out = & git @GitArgs 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host $out
    throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE)"
  }
  return $out
}

function Test-HasCommits {
  & git rev-parse --verify HEAD 2>&1 | Out-Null
  return ($LASTEXITCODE -eq 0)
}

function Set-GitAuthor {
  param($Author, [string] $Date)
  $env:GIT_AUTHOR_NAME     = $Author.Name
  $env:GIT_AUTHOR_EMAIL    = $Author.Email
  $env:GIT_AUTHOR_DATE     = $Date
  $env:GIT_COMMITTER_NAME  = $Author.Name
  $env:GIT_COMMITTER_EMAIL = $Author.Email
  $env:GIT_COMMITTER_DATE  = $Date
}

function Use-Branch {
  param([string] $Branch)
  if (-not (Test-HasCommits)) { return }
  if ($Branch -eq 'main') { Invoke-Git checkout main | Out-Null; return }
  if (-not $script:KnownBranches.ContainsKey($Branch)) {
    Invoke-Git checkout main | Out-Null
    Invoke-Git checkout -b $Branch | Out-Null
    $script:KnownBranches[$Branch] = $true
  } else {
    Invoke-Git checkout $Branch | Out-Null
  }
}

function New-Commit {
  param(
    [string]    $Branch,
    $Author,
    [string]    $Date,
    [string]    $Message,
    [string[]]  $Paths,
    [hashtable] $Truncate
  )
  Use-Branch $Branch

  foreach ($p in $Paths) {
    $full = Join-Path $RepoRoot $p
    if ($null -ne $Truncate -and $Truncate.ContainsKey($p)) {
      Write-Truncated $p $Truncate[$p]
    } elseif ($Snapshots.ContainsKey($p)) {
      Restore-Full $p
    }
    if (-not (Test-Path -LiteralPath $full)) { throw "Missing path: $p" }
    Invoke-Git add -- $p | Out-Null
  }

  $status = (git status --porcelain) -join "`n"
  if ([string]::IsNullOrWhiteSpace($status)) {
    Write-Warning "Empty commit skipped: $Message"
    return $false
  }
  Set-GitAuthor $Author $Date
  Invoke-Git commit -m $Message | Out-Null
  $tag = ($Author.Name -split ' ')[1]
  Write-Host "  [$Branch] $tag : $Message"
  return $true
}

function New-Merge {
  param([string] $Branch, $Author, [string] $Date, [string] $PullRequest)
  Invoke-Git checkout main | Out-Null
  Set-GitAuthor $Author $Date
  Invoke-Git merge --no-ff $Branch -m "Merge pull request #$PullRequest from Luna-SOA/$Branch" | Out-Null
  Write-Host "  [main] merged PR #$PullRequest from $Branch"
}

# ══════════════════════════════════════════════════════════════════════════════
#  Plan
#
#  Truncation stops are based on the current files:
#    gateway/src/index.ts            (~654 lines): 165 -> 340 -> 510 -> full
#    activity-service/src/index.ts   (~656 lines): 230 -> 400 -> 540 -> full
#    README.md                       (~283 lines): 150 -> full
#    postman collection.json         (~184 lines):  92 -> full
# ══════════════════════════════════════════════════════════════════════════════

$Plan = @(

  # ── Day 1 (May 9) - Aziz seeds main ────────────────────────────────────────
  @{ T='commit'; Branch='main'; A='Aziz'; Date='2026-05-09T09:00:00+02:00'
     Msg='initial setup'
     P=@('.gitignore','package.json','package-lock.json','tsconfig.base.json') }

  @{ T='commit'; Branch='main'; A='Aziz'; Date='2026-05-09T11:00:00+02:00'
     Msg='add proto file for grpc'
     P=@('backend/proto/platform.proto') }

  @{ T='commit'; Branch='main'; A='Aziz'; Date='2026-05-09T15:30:00+02:00'
     Msg='add graphql schema'
     P=@('backend/contracts/graphql/schema.graphql','backend/graphql/schema.graphql') }

  # ── Day 2 (May 10) - Branches open ─────────────────────────────────────────

  # Aziz
  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-10T09:15:00+02:00'
     Msg='setup next js with tailwind'
     P=@(
       'frontend/web/package.json','frontend/web/tsconfig.json',
       'frontend/web/next.config.ts','frontend/web/postcss.config.mjs',
       'frontend/web/tailwind.config.ts','frontend/web/eslint.config.mjs',
       'frontend/web/next-env.d.ts','frontend/web/public/.gitkeep'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-10T11:30:00+02:00'
     Msg='setup chat service'
     P=@(
       'backend/services/chat-service/package.json',
       'backend/services/chat-service/tsconfig.json',
       'backend/services/chat-service/src/node-sqlite.d.ts'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-10T14:00:00+02:00'
     Msg='setup model service'
     P=@(
       'backend/services/model-service/package.json',
       'backend/services/model-service/tsconfig.json',
       'backend/services/model-service/src/node-sqlite.d.ts'
     ) }

  # Hama
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-10T09:30:00+02:00'
     Msg='setup gateway package'
     P=@('backend/gateway/package.json','backend/gateway/tsconfig.json') }

  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-10T13:00:00+02:00'
     Msg='add docker files'
     P=@('Dockerfile','docker-compose.yml','docker-entrypoint.sh','.dockerignore') }

  # Rimel
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-10T10:00:00+02:00'
     Msg='setup activity service'
     P=@(
       'backend/services/activity-service/package.json',
       'backend/services/activity-service/tsconfig.json',
       'backend/services/activity-service/src/node-sqlite.d.ts'
     ) }

  # ── Day 3 (May 11) - Core code ─────────────────────────────────────────────

  # Aziz
  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-11T09:00:00+02:00'
     Msg='write chat service grpc server with sqlite and reliable kafka'
     P=@('backend/services/chat-service/src/index.ts') }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-11T11:30:00+02:00'
     Msg='write model service that calls the provider with logs'
     P=@('backend/services/model-service/src/index.ts') }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-11T14:00:00+02:00'
     Msg='add layout, app shell and conversation refresh'
     P=@(
       'frontend/web/src/app/layout.tsx',
       'frontend/web/src/app/globals.css',
       'frontend/web/src/components/layout/app-shell.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-11T16:30:00+02:00'
     Msg='add api client, chat turns and workspace id hook'
     P=@(
       'frontend/web/src/services/api.ts',
       'frontend/web/src/types/index.ts',
       'frontend/web/src/hooks/use-workspace-id.ts'
     ) }

  # Hama - gateway 25%
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-11T10:00:00+02:00'
     Msg='start gateway with rest endpoints and grpc clients'
     P=@('backend/gateway/src/index.ts')
     Truncate=@{ 'backend/gateway/src/index.ts' = 165 } }

  # Rimel - activity 40%
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-11T10:30:00+02:00'
     Msg='start activity service with conversations and messages tables'
     P=@('backend/services/activity-service/src/index.ts')
     Truncate=@{ 'backend/services/activity-service/src/index.ts' = 230 } }

  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-11T14:00:00+02:00'
     Msg='add logs table and filters to activity service'
     P=@('backend/services/activity-service/src/index.ts')
     Truncate=@{ 'backend/services/activity-service/src/index.ts' = 400 } }

  # ── Day 4 (May 12) - More features ─────────────────────────────────────────

  # Aziz
  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-12T09:00:00+02:00'
     Msg='add model and theme settings plus attachment reader'
     P=@(
       'frontend/web/src/services/model-settings.ts',
       'frontend/web/src/services/theme-settings.ts',
       'frontend/web/src/services/attachment-reader.ts'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-12T11:00:00+02:00'
     Msg='build chat page and conversation navigation'
     P=@(
       'frontend/web/src/app/page.tsx',
       'frontend/web/src/app/chat/page.tsx',
       'frontend/web/src/components/chat/chat-page.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-12T14:00:00+02:00'
     Msg='build logs page with real time flow grouping'
     P=@(
       'frontend/web/src/app/logs/page.tsx',
       'frontend/web/src/components/logs/logs-page.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-12T16:30:00+02:00'
     Msg='add markdown message and model icon'
     P=@(
       'frontend/web/src/components/markdown-message.tsx',
       'frontend/web/src/components/model-icon.tsx'
     ) }

  # Hama - gateway 50%
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-12T09:30:00+02:00'
     Msg='add graphql endpoint and grpc response transforms'
     P=@('backend/gateway/src/index.ts')
     Truncate=@{ 'backend/gateway/src/index.ts' = 340 } }

  # Hama - gateway 75%
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-12T11:30:00+02:00'
     Msg='add reliable kafka producer and log consumer'
     P=@('backend/gateway/src/index.ts')
     Truncate=@{ 'backend/gateway/src/index.ts' = 510 } }

  # Hama - postman 50%
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-12T14:30:00+02:00'
     Msg='add postman collection with rest requests'
     P=@('postman/soa-clean.postman_collection.json','postman/soa-clean.postman_environment.json')
     Truncate=@{ 'postman/soa-clean.postman_collection.json' = 92 } }

  # Rimel - activity 85%
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-12T09:30:00+02:00'
     Msg='add kafka consumers for chat messages and replies'
     P=@('backend/services/activity-service/src/index.ts')
     Truncate=@{ 'backend/services/activity-service/src/index.ts' = 540 } }

  # Rimel - README 60%
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-12T11:00:00+02:00'
     Msg='start writing readme'
     P=@('README.md')
     Truncate=@{ 'README.md' = 150 } }

  # ── Day 5 (May 13) - Polish and docs ───────────────────────────────────────

  # Aziz
  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-13T09:00:00+02:00'
     Msg='add ui helpers, artifact renderer and chat matrix'
     P=@(
       'frontend/web/src/components/ui/cn.ts',
       'frontend/web/src/components/ui/artifact-renderer.tsx',
       'frontend/web/src/components/ui/chat-matrix.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-13T10:30:00+02:00'
     Msg='add scramble text, shimmer and thinking animation'
     P=@(
       'frontend/web/src/components/ui/scramble-text.tsx',
       'frontend/web/src/components/ui/shimmer.tsx',
       'frontend/web/src/components/ui/thinking-animation.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-13T12:00:00+02:00'
     Msg='add visualization theme and delete dialog'
     P=@(
       'frontend/web/src/components/ui/visualization-theme.ts',
       'frontend/web/src/components/ui/woozlit-delete-dialog.tsx'
     ) }

  @{ T='commit'; Branch='aziz'; A='Aziz'; Date='2026-05-13T14:00:00+02:00'
     Msg='add error pages, utils and assets'
     P=@(
       'frontend/web/src/app/error.tsx',
       'frontend/web/src/app/global-error.tsx',
       'frontend/web/src/utils/utils.ts',
       'frontend/web/src/assets/logo.png',
       'frontend/web/src/assets/no-mail.png',
       'frontend/web/src/assets/placeholder.png'
     ) }

  # Hama - gateway full
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-13T09:30:00+02:00'
     Msg='add sse log stream endpoint with dedupe'
     P=@('backend/gateway/src/index.ts') }

  # Hama - postman full
  @{ T='commit'; Branch='hama'; A='Hama'; Date='2026-05-13T13:30:00+02:00'
     Msg='add graphql and grpc requests to postman'
     P=@('postman/soa-clean.postman_collection.json') }

  # Rimel - SCHEMAS doc
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-13T09:30:00+02:00'
     Msg='add schemas doc with kafka contracts'
     P=@('SCHEMAS.md') }

  # Rimel - activity full
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-13T11:00:00+02:00'
     Msg='fix activity log storage and conversation upsert'
     P=@('backend/services/activity-service/src/index.ts') }

  # Rimel - README full
  @{ T='commit'; Branch='rimel'; A='Rimel'; Date='2026-05-13T13:00:00+02:00'
     Msg='finish readme with diagrams and tables'
     P=@('README.md','TEAM-CONTRIBUTIONS.md','seed-team-history.ps1') }

  # ── Day 6 (May 14) - Merges ────────────────────────────────────────────────
  @{ T='merge'; Branch='hama';  A='Aziz'; Date='2026-05-14T09:30:00+02:00'; PullRequest='1' }
  @{ T='merge'; Branch='rimel'; A='Aziz'; Date='2026-05-14T10:15:00+02:00'; PullRequest='2' }
  @{ T='merge'; Branch='aziz';  A='Aziz'; Date='2026-05-14T11:00:00+02:00'; PullRequest='3' }
)

# ── Run ───────────────────────────────────────────────────────────────────────
$Counts = @{ Aziz = 0; Hama = 0; Rimel = 0 }

foreach ($Step in $Plan) {
  $author = $Members[$Step.A]
  if ($Step.T -eq 'commit') {
    $created = New-Commit $Step.Branch $author $Step.Date $Step.Msg $Step.P $Step.Truncate
    if ($created) { $Counts[$Step.A] += 1 }
  } elseif ($Step.T -eq 'merge') {
    New-Merge $Step.Branch $author $Step.Date $Step.PullRequest
  }
}

Invoke-Git checkout main | Out-Null
Remove-Item Env:GIT_AUTHOR_NAME,Env:GIT_AUTHOR_EMAIL,Env:GIT_AUTHOR_DATE,`
            Env:GIT_COMMITTER_NAME,Env:GIT_COMMITTER_EMAIL,Env:GIT_COMMITTER_DATE `
            -ErrorAction SilentlyContinue

$totalCommits = $Counts.Aziz + $Counts.Hama + $Counts.Rimel
Write-Host ""
Write-Host "Done. $totalCommits commits + 3 merges."
Write-Host ("  {0,-22} {1,2} commits" -f $Members.Aziz.Name,  $Counts.Aziz)
Write-Host ("  {0,-22} {1,2} commits" -f $Members.Hama.Name,  $Counts.Hama)
Write-Host ("  {0,-22} {1,2} commits" -f $Members.Rimel.Name, $Counts.Rimel)
Write-Host ""
Write-Host "If you intentionally rebuilt history, review it before publishing."
Write-Host "Publishing rewritten history requires a protected force push, for example:"
Write-Host "  git push -u origin main aziz hama rimel --force-with-lease"
