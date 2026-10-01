# Launch Chrome with DevTools remote debugging, a copy of the default profile
# (incl. all extensions) and expose the port to the LAN.
# Run in an elevated PowerShell (needed for portproxy/firewall):
#   powershell -ExecutionPolicy Bypass -File .\chrome-remote-debug.ps1 [-LanPort 9222] [-Fresh]
param([int]$LanPort = 9222, [switch]$Fresh)
$ErrorActionPreference = 'Stop'
$LocalPort = 9223

$Chrome = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
            "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
            "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe") |
          Where-Object { Test-Path $_ } | Select-Object -First 1
$Src = "$env:LOCALAPPDATA\Google\Chrome\User Data"
$Dst = "$env:LOCALAPPDATA\ChromeRemoteDebugProfile"

if (Get-Process chrome -ErrorAction SilentlyContinue) {
  Write-Error "Chrome is running - close it completely (incl. tray) first."
}

# Chrome 136+ ignores --remote-debugging-port on the default user-data-dir,
# so we run on a copy of it.
if ($Fresh -or -not (Test-Path $Dst)) {
  Write-Host "Copying profile $Src -> $Dst ..."
  robocopy $Src $Dst /MIR /XD Cache "Code Cache" GPUCache CacheStorage /XF "Singleton*" /NFL /NDL /NJH /NJS | Out-Null
}

Start-Process $Chrome -ArgumentList @(
  "--user-data-dir=`"$Dst`"", "--profile-directory=Default",
  "--remote-debugging-port=$LocalPort", "--remote-allow-origins=*",
  "--no-first-run", "--no-default-browser-check")

# Headful Chrome binds DevTools to 127.0.0.1 only -> forward from LAN.
netsh interface portproxy delete v4tov4 listenport=$LanPort listenaddress=0.0.0.0 2>$null | Out-Null
netsh interface portproxy add v4tov4 listenport=$LanPort listenaddress=0.0.0.0 connectport=$LocalPort connectaddress=127.0.0.1 | Out-Null
if (-not (Get-NetFirewallRule -DisplayName "Chrome DevTools $LanPort" -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName "Chrome DevTools $LanPort" -Direction Inbound -Protocol TCP `
    -LocalPort $LanPort -Profile Private -Action Allow | Out-Null
}

$Ip = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.PrefixOrigin -in 'Dhcp','Manual' -and $_.IPAddress -notlike '169.*' } | Select-Object -First 1).IPAddress
Write-Host "DevTools: http://${Ip}:$LanPort/json/version"
Write-Host "From another PC: chromium.connect_over_cdp('http://${Ip}:$LanPort')"
Write-Host "To remove forwarding: netsh interface portproxy delete v4tov4 listenport=$LanPort listenaddress=0.0.0.0"
