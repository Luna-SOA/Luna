param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("pause", "resume", "status")]
  [string]$Action
)

$ErrorActionPreference = "Stop"

$resumeOrder = @("kafka", "model-service", "activity-service", "chat-service", "web")
$pauseOrder = @("web", "chat-service", "activity-service", "model-service", "kafka")
$graphqlUrl = "https://backboard.railway.com/graphql/v2"

function Get-RailwayToken {
  if ($env:RAILWAY_TOKEN) { return $env:RAILWAY_TOKEN }

  $configPath = Join-Path $HOME ".railway/config.json"
  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if ($config.user.token) { return $config.user.token }
  }

  throw "Railway token not found. Run 'railway login' first or set RAILWAY_TOKEN."
}

function Invoke-RailwayGraphQL {
  param(
    [Parameter(Mandatory = $true)][string]$Query,
    [Parameter(Mandatory = $false)][hashtable]$Variables = @{}
  )

  $headers = @{
    Authorization = "Bearer $(Get-RailwayToken)"
    "Content-Type" = "application/json"
  }
  $body = @{ query = $Query; variables = $Variables } | ConvertTo-Json -Depth 20 -Compress
  $result = Invoke-RestMethod -Uri $graphqlUrl -Method Post -Headers $headers -Body $body
  if ($result.errors) { throw (($result.errors | ConvertTo-Json -Depth 10)) }
  return $result.data
}

function Get-RailwayStatus {
  $json = railway status --json
  if ($LASTEXITCODE -ne 0) { throw "railway status failed" }
  return $json | ConvertFrom-Json
}

function Get-ServiceMap {
  $status = Get-RailwayStatus
  $environment = $status.environments.edges[0].node
  $services = @{}

  foreach ($edge in $status.services.edges) {
    $service = $edge.node
    $instance = $service.serviceInstances.edges[0].node
    $services[$service.name] = [pscustomobject]@{
      Name = $service.name
      Id = $service.id
      EnvironmentId = $environment.id
      SourceRepo = $instance.source.repo
      SourceImage = $instance.source.image
      DeploymentId = $instance.latestDeployment.id
      DeploymentStatus = $instance.latestDeployment.status
      DeploymentStopped = $instance.latestDeployment.deploymentStopped
    }
  }

  return $services
}

function Show-ServiceStatus {
  $services = Get-ServiceMap
  foreach ($name in $resumeOrder) {
    $service = $services[$name]
    if (-not $service) { continue }
    $source = if ($service.SourceRepo) { $service.SourceRepo } elseif ($service.SourceImage) { $service.SourceImage } else { "none" }
    $state = if ($service.DeploymentStopped) { "stopped" } else { $service.DeploymentStatus }
    "{0,-16} {1,-10} {2}" -f $service.Name, $state, $source
  }
}

function Pause-Services {
  $services = Get-ServiceMap
  $mutation = "mutation(`$id:String!) { deploymentStop(id:`$id) }"

  foreach ($name in $pauseOrder) {
    $service = $services[$name]
    if (-not $service) { continue }
    if (-not $service.DeploymentId) { "skip ${name}: no deployment"; continue }
    if ($service.DeploymentStopped) { "skip ${name}: already stopped"; continue }

    Invoke-RailwayGraphQL -Query $mutation -Variables @{ id = $service.DeploymentId } | Out-Null
    "paused $name"
  }
}

function Resume-Services {
  $services = Get-ServiceMap
  $mutation = "mutation(`$serviceId:String!, `$environmentId:String!, `$latestCommit:Boolean) { serviceInstanceDeploy(serviceId:`$serviceId, environmentId:`$environmentId, latestCommit:`$latestCommit) }"

  foreach ($name in $resumeOrder) {
    $service = $services[$name]
    if (-not $service) { continue }

    $latestCommit = [bool]$service.SourceRepo
    Invoke-RailwayGraphQL -Query $mutation -Variables @{ serviceId = $service.Id; environmentId = $service.EnvironmentId; latestCommit = $latestCommit } | Out-Null
    "resumed $name"
    Start-Sleep -Seconds 3
  }
}

switch ($Action) {
  "pause" { Pause-Services }
  "resume" { Resume-Services }
  "status" { Show-ServiceStatus }
}
