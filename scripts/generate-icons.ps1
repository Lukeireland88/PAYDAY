Add-Type -AssemblyName System.Drawing

function Resize-Icon {
  param([string]$Source, [int]$Size, [string]$Dest)
  $src = [System.Drawing.Image]::FromFile($Source)
  $bmp = New-Object System.Drawing.Bitmap $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.DrawImage($src, 0, 0, $Size, $Size)
  $bmp.Save($Dest, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  $src.Dispose()
}

$iconDir = Join-Path $PSScriptRoot '..\icons'
$source = Join-Path $iconDir 'icon-512.png'
if (-not (Test-Path $source)) { throw "Missing $source — add a 512x512 master icon first." }
Resize-Icon -Source $source -Size 192 -Dest (Join-Path $iconDir 'icon-192.png')
Resize-Icon -Source $source -Size 180 -Dest (Join-Path $iconDir 'apple-touch-icon.png')
Write-Output 'Icons created'
