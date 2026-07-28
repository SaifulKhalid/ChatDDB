$hosts = "C:\Windows\System32\drivers\etc\hosts"
$entries = @(
    ""
    "# GitHub"
    "20.205.243.166 github.com"
    "# Cloudflare API"
    "104.19.192.29 api.cloudflare.com"
    "104.17.111.184 dash.cloudflare.com"
)
Add-Content -Path $hosts -Value $entries
Write-Host "Hosts file updated successfully"
