# Значок пульта ВК в трее. Запускается сервером (server.js) скрытым процессом PowerShell.
# Клик по значку — окно с актуальным QR-кодом для телефона. Сам выходит, когда сервер остановлен.
param([int]$Port = 27613, [string]$Icon = '')

Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
# Системный прокси (его ставят VPN-клиенты) не должен перехватывать запросы к 127.0.0.1.
[System.Net.WebRequest]::DefaultWebProxy = $null

$base = "http://127.0.0.1:$Port"

function Invoke-Server([string]$path, [switch]$Post) {
  try {
    $wc = New-Object System.Net.WebClient
    $wc.Proxy = $null
    $wc.Encoding = [System.Text.Encoding]::UTF8
    if ($Post) {
      $wc.Headers.Add('X-VKR', '1')
      $text = $wc.UploadString($base + $path, 'POST', '')
    } else {
      $text = $wc.DownloadString($base + $path)
    }
    return ($text | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$appIcon = if ($Icon -and (Test-Path $Icon)) { New-Object System.Drawing.Icon($Icon) } else { [System.Drawing.SystemIcons]::Application }

# ---------- окно с QR ----------
$script:form = $null
$script:qrIndex = 0
$script:shownUrl = $null

function Update-QrForm {
  $f = $script:form
  if (-not $f -or $f.IsDisposed) { return }
  $info = Invoke-Server "/tray/qr?i=$($script:qrIndex)"
  if (-not $info) {
    $f.Controls['status'].Text = 'Пульт не отвечает. Нажми ярлык «Управлять музыкой через ВК» на рабочем столе.'
    return
  }
  if ($info.gif -and $info.url -ne $script:shownUrl) {
    $script:shownUrl = $info.url
    $bytes = [Convert]::FromBase64String($info.gif)
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $old = $f.Controls['qr'].Image
    $f.Controls['qr'].Image = [System.Drawing.Image]::FromStream($ms)
    if ($old) { $old.Dispose() }
  }
  $f.Controls['url'].Text = $info.url
  # Основной адрес — почти всегда домашний Wi-Fi. Запасные (виртуальные сети, VPN) показываем
  # только по просьбе и с предупреждением: раньше по ним легко было уйти на нерабочий адрес.
  $isSpare = ($script:qrIndex % [Math]::Max(1, $info.count)) -ne 0
  $f.Controls['next'].Visible = ($info.count -gt 1)
  $f.Controls['next'].Text = if ($isSpare) { 'Следующий запасной адрес' } else { 'Телефон не открывает? Запасной адрес' }
  $f.Controls['back'].Visible = $isSpare
  if ($isSpare) {
    $f.Controls['status'].Text = 'Это ЗАПАСНОЙ адрес — он нужен редко. Если и он не открывается, вернись к основному.'
    $f.Controls['status'].ForeColor = [System.Drawing.Color]::FromArgb(190, 60, 40)
  } elseif ($info.agentOnline) {
    $f.Controls['status'].Text = 'Окно ВК на связи. Наведи камеру телефона на код и открой ссылку.'
    $f.Controls['status'].ForeColor = [System.Drawing.Color]::FromArgb(30, 130, 70)
  } else {
    $f.Controls['status'].Text = 'Окно ВК на компьютере не открыто или в нём не выполнен вход. Код всё равно можно сканировать.'
    $f.Controls['status'].ForeColor = [System.Drawing.Color]::FromArgb(170, 110, 20)
  }
}

function Show-QrForm {
  $script:qrIndex = 0 # каждый раз начинаем с основного адреса
  if ($script:form -and -not $script:form.IsDisposed) {
    $script:shownUrl = $null
    Update-QrForm
    $script:form.WindowState = 'Normal'
    $script:form.Activate()
    return
  }
  $f = New-Object System.Windows.Forms.Form
  $f.Text = 'Пульт ВК — QR-код для телефона'
  $f.Icon = $appIcon
  $f.StartPosition = 'CenterScreen'
  $f.FormBorderStyle = 'FixedDialog'
  $f.MaximizeBox = $false
  $f.MinimizeBox = $false
  $f.TopMost = $true
  $f.BackColor = [System.Drawing.Color]::White
  $f.ClientSize = New-Object System.Drawing.Size(400, 590)
  $f.Font = New-Object System.Drawing.Font('Segoe UI', 10)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'Наведи камеру телефона'
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 15, [System.Drawing.FontStyle]::Bold)
  $title.SetBounds(20, 14, 360, 34)
  $title.TextAlign = 'MiddleCenter'
  $f.Controls.Add($title)

  $pic = New-Object System.Windows.Forms.PictureBox
  $pic.Name = 'qr'
  $pic.SetBounds(30, 54, 340, 340)
  $pic.SizeMode = 'CenterImage'
  $f.Controls.Add($pic)

  $url = New-Object System.Windows.Forms.Label
  $url.Name = 'url'
  $url.SetBounds(20, 398, 360, 22)
  $url.TextAlign = 'MiddleCenter'
  $url.ForeColor = [System.Drawing.Color]::Gray
  $url.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
  $f.Controls.Add($url)

  $status = New-Object System.Windows.Forms.Label
  $status.Name = 'status'
  $status.SetBounds(20, 424, 360, 44)
  $status.TextAlign = 'MiddleCenter'
  $f.Controls.Add($status)

  $next = New-Object System.Windows.Forms.Button
  $next.Name = 'next'
  $next.Text = 'Телефон не открывает? Другой адрес'
  $next.SetBounds(50, 474, 300, 32)
  $next.Add_Click({ $script:qrIndex++; Update-QrForm })
  $f.Controls.Add($next)

  $back = New-Object System.Windows.Forms.LinkLabel
  $back.Name = 'back'
  $back.Text = 'Вернуть основной адрес'
  $back.SetBounds(20, 512, 360, 24)
  $back.TextAlign = 'MiddleCenter'
  $back.Add_LinkClicked({ $script:qrIndex = 0; Update-QrForm })
  $f.Controls.Add($back)

  $help = New-Object System.Windows.Forms.LinkLabel
  $help.Text = 'Помощь: VPN на телефоне, брандмауэр'
  $help.SetBounds(20, 546, 360, 24)
  $help.TextAlign = 'MiddleCenter'
  $help.Add_LinkClicked({ Start-Process "$base/setup" })
  $f.Controls.Add($help)

  $f.Add_FormClosed({ $script:form = $null; $script:shownUrl = $null })
  $script:form = $f
  Update-QrForm
  $f.Show()
  $f.Activate()
}

# ---------- значок ----------
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $appIcon
$notify.Text = 'Пульт ВК — нажми, чтобы показать QR-код'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miQr = $menu.Items.Add('Показать QR-код')
$miQr.Font = New-Object System.Drawing.Font($miQr.Font, [System.Drawing.FontStyle]::Bold)
$miQr.Add_Click({ Show-QrForm })
$menu.Items.Add('Открыть окно ВК').Add_Click({ Invoke-Server '/local/launch' -Post | Out-Null })
$menu.Items.Add('Помощь и настройки').Add_Click({ Start-Process "$base/setup" })
$menu.Items.Add('-') | Out-Null
$menu.Items.Add('Выключить пульт').Add_Click({
  Invoke-Server '/shutdown' -Post | Out-Null
  $notify.Visible = $false
  [System.Windows.Forms.Application]::Exit()
})
$notify.ContextMenuStrip = $menu
$notify.Add_MouseClick({ if ($_.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Show-QrForm } })

# Опрос сервера: просьба показать QR (ярлык на рабочем столе) и проверка, что сервер жив.
$script:fails = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({
  $p = Invoke-Server '/tray/poll'
  if (-not $p) {
    $script:fails++
    if ($script:fails -ge 4) {
      $timer.Stop()
      $notify.Visible = $false
      [System.Windows.Forms.Application]::Exit()
    }
    return
  }
  $script:fails = 0
  if ($p.showQr) { Show-QrForm }
  elseif ($script:form -and -not $script:form.IsDisposed) { Update-QrForm }
})
$timer.Start()

$notify.ShowBalloonTip(8000, 'Пульт ВК работает', 'Нажми на этот значок, чтобы показать QR-код для телефона. Не видно значка — нажми стрелку ^ рядом с часами.', [System.Windows.Forms.ToolTipIcon]::Info)

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  $notify.Visible = $false
  $notify.Dispose()
}
