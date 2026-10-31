# Tiny static web server for previewing the Black Diamond Atlas (no Python, Node or admin rights needed).
#
#   powershell -ExecutionPolicy Bypass -File serve.ps1          -> this computer only (http://localhost:8002)
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Lan     -> also phones/tablets on your Wi-Fi
#
# Press Ctrl+C (or close the window) to stop.
param(
  [int]$Port = 8002,
  [switch]$Lan
)

$root = (Resolve-Path $PSScriptRoot).Path.TrimEnd('\')
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.js' = 'application/javascript; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.geojson' = 'application/geo+json; charset=utf-8'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.webp' = 'image/webp'
  '.gif' = 'image/gif'; '.ico' = 'image/x-icon'; '.md' = 'text/plain; charset=utf-8'
  '.txt' = 'text/plain; charset=utf-8'
}
$reasons = @{ 200 = 'OK'; 400 = 'Bad Request'; 404 = 'Not Found'; 405 = 'Method Not Allowed' }

# -Lan listens on every network adapter (0.0.0.0); otherwise only on this computer.
$address = if ($Lan) { [Net.IPAddress]::Any } else { [Net.IPAddress]::Loopback }
$listener = New-Object Net.Sockets.TcpListener($address, $Port)
try {
  $listener.Start()
} catch {
  Write-Host "Could not start on port $Port. Is another server already running? Close it, or use -Port 8080." -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "  Serving: $root"
Write-Host "  On this computer:  http://localhost:$Port/" -ForegroundColor Green
if ($Lan) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object {
    $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and
    $_.InterfaceAlias -notlike 'vEthernet*' -and $_.InterfaceAlias -notlike '*Loopback*'
  }
  foreach ($ip in $ips) {
    Write-Host "  On your phone:     http://$($ip.IPAddress):$Port/   ($($ip.InterfaceAlias))" -ForegroundColor Cyan
  }
  Write-Host "  (Phone must be on the same Wi-Fi/router as this computer.)"
}
Write-Host "  Press Ctrl+C or close this window to stop."
Write-Host ""

try {
  while ($true) {
    # Poll instead of blocking so Ctrl+C works.
    if (-not $listener.Pending()) { Start-Sleep -Milliseconds 25; continue }
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 2000
      $client.SendTimeout = 10000
      $stream = $client.GetStream()
      $reader = New-Object IO.StreamReader($stream, [Text.Encoding]::ASCII, $false, 8192, $true)

      $requestLine = $reader.ReadLine()
      if (-not $requestLine) { continue }
      while ($reader.ReadLine()) { }   # skip headers up to the blank line

      $parts = $requestLine.Split(' ')
      $method = $parts[0]
      $code = 200
      $type = 'text/plain; charset=utf-8'
      [byte[]]$body = @()

      if ($parts.Length -lt 2) {
        $code = 400
      } elseif ($method -ne 'GET' -and $method -ne 'HEAD') {
        $code = 405
      } else {
        $path = [Uri]::UnescapeDataString(($parts[1] -split '[?#]')[0]).TrimStart('/')
        if ($path -eq '' -or $path.EndsWith('/')) { $path += 'index.html' }
        $file = [IO.Path]::GetFullPath((Join-Path $root $path))
        if ($file.StartsWith($root + '\') -and (Test-Path -LiteralPath $file -PathType Leaf)) {
          $body = [IO.File]::ReadAllBytes($file)
          $ext = [IO.Path]::GetExtension($file).ToLower()
          if ($types[$ext]) { $type = $types[$ext] } else { $type = 'application/octet-stream' }
        } else {
          $code = 404
        }
      }
      if ($code -ne 200) { $body = [Text.Encoding]::UTF8.GetBytes("$code $($reasons[$code])") }

      $header = "HTTP/1.1 $code $($reasons[$code])`r`nContent-Type: $type`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
      $headerBytes = [Text.Encoding]::ASCII.GetBytes($header)
      $stream.Write($headerBytes, 0, $headerBytes.Length)
      if ($method -ne 'HEAD' -and $body.Length) { $stream.Write($body, 0, $body.Length) }
      $stream.Flush()

      $from = $client.Client.RemoteEndPoint.Address
      Write-Host ("{0} {1,-4} {2}  <- {3}" -f $code, $method, $parts[1], $from)
    } catch {
      # Phones often open a connection and never use it; those time out here harmlessly.
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
}
