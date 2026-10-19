# Lets phones on a private (home) network reach the CyclingOS Zwift Wi-Fi stream on Windows.
# Opens only the stream port (TCP) and Bonjour discovery (UDP 5353), only for node.exe, only on Private networks.
# Run from an elevated PowerShell, or via: npm run firewall:win  (prompts for administrator approval).
param([int]$Port = 8788, [string]$Node = (Get-Command node -ErrorAction Stop).Source)

$ErrorActionPreference = "Stop"
$name = "CyclingOS Zwift Wi-Fi"
Get-NetFirewallRule -DisplayName "$name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName "$name stream (TCP $Port)" -Direction Inbound -Action Allow -Profile Private `
  -Program $Node -Protocol TCP -LocalPort $Port | Out-Null
New-NetFirewallRule -DisplayName "$name discovery (mDNS)" -Direction Inbound -Action Allow -Profile Private `
  -Program $Node -Protocol UDP -LocalPort 5353 | Out-Null
Write-Host "Allowed $Node on Private networks: TCP $Port and UDP 5353."
