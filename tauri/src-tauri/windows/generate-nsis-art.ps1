Add-Type -AssemblyName System.Drawing

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$iconPath = Join-Path $here "..\icons\icon.png"
$outDir = $here

# NSIS MUI needs uncompressed 24-bit BMP (no alpha). GDI+ ImageFormat.Bmp
# can emit 32-bit, so write the file header ourselves.
function Save-Bmp24([System.Drawing.Bitmap]$bmp, [string]$path) {
  $w = $bmp.Width
  $h = $bmp.Height
  $rowStride = [Math]::Ceiling($w * 3 / 4.0) * 4
  $pixelSize = $rowStride * $h
  $fileSize = 54 + $pixelSize
  $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
  $bw = New-Object System.IO.BinaryWriter $fs
  $bw.Write([byte]0x42)
  $bw.Write([byte]0x4D)
  $bw.Write([uint32]$fileSize)
  $bw.Write([uint16]0)
  $bw.Write([uint16]0)
  $bw.Write([uint32]54)
  $bw.Write([uint32]40)
  $bw.Write([int32]$w)
  $bw.Write([int32]$h)
  $bw.Write([uint16]1)
  $bw.Write([uint16]24)
  $bw.Write([uint32]0)
  $bw.Write([uint32]$pixelSize)
  $bw.Write([int32]2835)
  $bw.Write([int32]2835)
  $bw.Write([uint32]0)
  $bw.Write([uint32]0)
  $pad = New-Object byte[] ($rowStride - ($w * 3))
  for ($y = $h - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $w; $x++) {
      $c = $bmp.GetPixel($x, $y)
      $bw.Write([byte]$c.B)
      $bw.Write([byte]$c.G)
      $bw.Write([byte]$c.R)
    }
    if ($pad.Length -gt 0) { $bw.Write($pad) }
  }
  $bw.Dispose()
}

function New-Canvas([int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::FromArgb(0x11, 0x11, 0x13))
  return @{ Bmp = $bmp; G = $g }
}

$icon = [System.Drawing.Image]::FromFile((Resolve-Path $iconPath))

$header = New-Canvas 150 57
$header.G.DrawImage($icon, 8, 8, 41, 41)
$font = New-Object System.Drawing.Font "Segoe UI Semibold", 11, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xfa, 0xfa, 0xfa))
$header.G.DrawString("Paperweight", $font, $brush, 54, 18)
$headerPath = Join-Path $outDir "header.bmp"
Save-Bmp24 $header.Bmp $headerPath
$header.G.Dispose()
$header.Bmp.Dispose()
$font.Dispose()

$side = New-Canvas 164 314
$side.G.DrawImage($icon, 34, 48, 96, 96)
$font2 = New-Object System.Drawing.Font "Segoe UI", 9, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Point)
$muted = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xa1, 0xa1, 0xaa))
$sf = New-Object System.Drawing.StringFormat
$sf.Alignment = [System.Drawing.StringAlignment]::Center
$side.G.DrawString("Paperweight", $font2, $brush, (New-Object System.Drawing.RectangleF 8, 156, 148, 24), $sf)
$side.G.DrawString("PDF / EPUB", $font2, $muted, (New-Object System.Drawing.RectangleF 8, 178, 148, 24), $sf)
$accent = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x3b, 0x82, 0xf6))
$side.G.FillRectangle($accent, 0, 0, 164, 4)
$side.G.FillRectangle($accent, 0, 310, 164, 4)
$sidePath = Join-Path $outDir "sidebar.bmp"
Save-Bmp24 $side.Bmp $sidePath
$side.G.Dispose()
$side.Bmp.Dispose()
$font2.Dispose()
$brush.Dispose()
$muted.Dispose()
$accent.Dispose()
$icon.Dispose()

Write-Output "Wrote $headerPath"
Write-Output "Wrote $sidePath"
