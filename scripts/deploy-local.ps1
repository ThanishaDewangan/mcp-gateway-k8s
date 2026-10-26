param(
  [string]$ClusterName = "mcp-gateway"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

foreach ($command in @("docker", "kind", "kubectl", "helm")) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "Required command '$command' was not found."
  }
}

& $env:ComSpec /d /c "docker info >nul 2>&1"
if ($LASTEXITCODE -ne 0) {
  throw "Docker Desktop is not running. Start its Linux container engine and retry."
}

$cluster = kind get clusters
if ($cluster -notcontains $ClusterName) {
  kind create cluster --name $ClusterName --config .\kind-config.yaml
  if ($LASTEXITCODE -ne 0) { throw "Could not create kind cluster." }
}
kubectl config use-context "kind-$ClusterName"
if ($LASTEXITCODE -ne 0) { throw "Could not select the kind cluster context." }

docker build -t mcp-gateway:dev .
if ($LASTEXITCODE -ne 0) { throw "Application image build failed." }
kind load docker-image mcp-gateway:dev --name $ClusterName
if ($LASTEXITCODE -ne 0) { throw "Could not load the application image into kind." }

docker build -f .\wordpress\Dockerfile -t mcp-woocommerce:dev .
if ($LASTEXITCODE -ne 0) { throw "WooCommerce-enabled WordPress image build failed." }
kind load docker-image mcp-woocommerce:dev --name $ClusterName
if ($LASTEXITCODE -ne 0) { throw "Could not load the WooCommerce image into kind." }

kubectl create namespace mcp-gateway --dry-run=client -o yaml | kubectl apply --validate=false -f -
if ($LASTEXITCODE -ne 0) { throw "Could not prepare the namespace." }

$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
function New-SecretValue([int]$Length = 32) {
  $bytes = New-Object byte[] $Length
  $random.GetBytes($bytes)
  return [Convert]::ToBase64String($bytes)
}

$existingSecretJson = kubectl -n mcp-gateway get secret mcp-gateway-secrets -o json --ignore-not-found
if ($LASTEXITCODE -ne 0) { throw "Could not inspect the existing application Secret." }

if ($existingSecretJson) {
  $existingSecret = $existingSecretJson | ConvertFrom-Json
  function Read-ExistingSecret([string]$key) {
    $encoded = $existingSecret.data[$key]
    if (-not $encoded) { throw "Existing Kubernetes Secret is missing key '$key'." }
    return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  }
  $adminToken = Read-ExistingSecret "dashboard-admin-token"
  $sampleToken = Read-ExistingSecret "sample-mcp-auth-token"
  $wordpressPassword = Read-ExistingSecret "wordpress-admin-password"
} else {
  $encryptionKey = New-SecretValue 32
  $adminToken = New-SecretValue 32
  $mcpToken = New-SecretValue 32
  $sampleToken = New-SecretValue 32
  $dbPassword = New-SecretValue 24
  $rootPassword = New-SecretValue 24
  $wordpressPassword = New-SecretValue 24

  $secureLlmKey = Read-Host "LLM provider API key (leave blank to configure later)" -AsSecureString
  $llmKeyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureLlmKey)
  try {
    $llmKey = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($llmKeyPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($llmKeyPointer)
  }

  kubectl -n mcp-gateway create secret generic mcp-gateway-secrets `
    "--from-literal=credentials-encryption-key=$encryptionKey" `
    "--from-literal=dashboard-admin-token=$adminToken" `
    "--from-literal=store-mcp-auth-token=$mcpToken" `
    "--from-literal=sample-mcp-auth-token=$sampleToken" `
    "--from-literal=mariadb-password=$dbPassword" `
    "--from-literal=mariadb-root-password=$rootPassword" `
    "--from-literal=wordpress-admin-password=$wordpressPassword" `
    "--from-literal=llm-api-key=$llmKey" `
    "--from-literal=woocommerce-consumer-key=" `
    "--from-literal=woocommerce-consumer-secret=" `
    --dry-run=client -o yaml | kubectl apply --validate=false -f -
  if ($LASTEXITCODE -ne 0) { throw "Could not create application secrets." }
}

helm upgrade --install mcp-gateway .\helm\mcp-gateway `
  --namespace mcp-gateway `
  --create-namespace `
  --values .\helm\mcp-gateway\values-local.yaml
if ($LASTEXITCODE -ne 0) { throw "Helm deployment failed." }
kubectl -n mcp-gateway wait --for=condition=available deployment --all --timeout=10m
if ($LASTEXITCODE -ne 0) { throw "Workloads did not become available; inspect pod events and logs." }

Write-Host ""
Write-Host "Deployed. Dashboard admin token (copy it now): $adminToken" -ForegroundColor Yellow
Write-Host "Store WordPress admin user: store-admin"
Write-Host "Store WordPress admin password (copy it now): $wordpressPassword" -ForegroundColor Yellow
Write-Host "Sample MCP credential for dashboard registration (copy it now): $sampleToken" -ForegroundColor Yellow
Write-Host "Ingress is not installed by this script. For kind, install ingress-nginx as described in README.md."
