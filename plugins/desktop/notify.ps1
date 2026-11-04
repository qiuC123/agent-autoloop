param([string]$TitleBase64, [string]$BodyBase64)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$title = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TitleBase64))
$body = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($BodyBase64))
$notification = New-Object System.Windows.Forms.NotifyIcon
try {
    $notification.Icon = [System.Drawing.SystemIcons]::Information
    $notification.Visible = $true
    $notification.ShowBalloonTip(5000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Seconds 6
} finally {
    $notification.Dispose()
}
