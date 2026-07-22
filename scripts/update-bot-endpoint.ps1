# Update Azure Bot messaging endpoint using service principal credentials
# Reads BOT_ENDPOINT from env/.env.local, uses AZURE_CLIENT_ID/SECRET from env/.env.local.user

param(
    [string]$SubscriptionId = "582b74e6-6cea-4329-8cb4-473b9653ae03",
    [string]$ResourceGroup  = "EdgarO_RG_MCPP_WU2",
    [string]$TenantId       = "588cadf4-9902-4465-86c0-8bcf04f4f102"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Parse a key=value env file
function Read-EnvFile([string]$path) {
    $map = @{}
    Get-Content $path | Where-Object { $_ -match "^\s*([^#=\s][^=]*?)\s*=\s*(.*)\s*$" } | ForEach-Object {
        if ($_ -match "^([^=]+)=(.*)$") { $map[$Matches[1].Trim()] = $Matches[2].Trim() }
    }
    return $map
}

$root = Split-Path $PSScriptRoot -Parent
$local    = Read-EnvFile (Join-Path $root "env\.env.local")
$localUser = Read-EnvFile (Join-Path $root "env\.env.local.user")

$botId       = $local["BOT_ID"]
$newEndpoint = "$($local["BOT_ENDPOINT"])/api/messages"
$clientId    = $localUser["AZURE_CLIENT_ID"]
$clientSecret= $localUser["AZURE_CLIENT_SECRET"]

Write-Host "Updating bot endpoint → $newEndpoint"
Write-Host "Bot: $botId  RG: $ResourceGroup  Sub: $SubscriptionId"

# 1. Get ARM token via client_credentials
$tok = (Invoke-RestMethod -Method POST `
    -Uri "https://login.microsoftonline.com/$TenantId/oauth2/v2.0/token" `
    -Body @{
        grant_type    = "client_credentials"
        client_id     = $clientId
        client_secret = $clientSecret
        scope         = "https://management.azure.com/.default"
    }).access_token
Write-Host "Token obtained."

$hdrs = @{ Authorization = "Bearer $tok"; "Content-Type" = "application/json" }
$apiVer = "2022-09-15"
$baseUrl = "https://management.azure.com/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/Microsoft.BotService/botServices/$botId"

# 2. GET current resource (need location + full body for PUT)
Write-Host "Getting current resource..."
$res = Invoke-RestMethod -Method GET -Uri "${baseUrl}?api-version=$apiVer" -Headers $hdrs
Write-Host "Current endpoint : $($res.properties.endpoint)"
Write-Host "Location         : $($res.location)"

# 3. PATCH just the endpoint
$body = @{ properties = @{ endpoint = $newEndpoint } } | ConvertTo-Json -Depth 3
Write-Host "Patching endpoint..."
$patched = Invoke-RestMethod -Method PATCH -Uri "${baseUrl}?api-version=$apiVer" -Headers $hdrs -Body $body
Write-Host "SUCCESS - new endpoint: $($patched.properties.endpoint)"
