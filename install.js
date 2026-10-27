// Разовая настройка для режима «без расширений» (вызывается из «Установить пульт VK.bat»):
// правило брандмауэра, чтобы телефон достучался до ПК, и ярлык на рабочем столе.

'use strict';
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SHORTCUT_NAME = 'Управлять музыкой через ВК';

// PowerShell 5.1 читает .ps1 без BOM в ANSI и ломает кириллицу в путях — пишем UTF-8 с BOM.
function runPs1(file, body, { elevated = false } = {}) {
  fs.writeFileSync(file, '﻿' + body, 'utf8');
  const q = (s) => s.replace(/'/g, "''");
  const cmd = elevated
    ? `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${q(file)}"'`
    : `& '${q(file)}'`;
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true }, (err) =>
      resolve(!err)
    );
  });
}

const psStr = (s) => "'" + String(s).replace(/'/g, "''") + "'";

async function installFirewall({ dataDir, nodePath }) {
  // Разрешаем входящие для node.exe пульта во всех профилях сети и убираем блокирующие правила,
  // которые Windows создаёт, если в её окне нажать «Отмена».
  const body = `
$node = ${psStr(nodePath)}
Get-NetFirewallRule -DisplayName 'VK Remote' -ErrorAction SilentlyContinue | Remove-NetFirewallRule
Get-NetFirewallApplicationFilter -Program $node -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Action -eq 'Block' } | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName 'VK Remote' -Direction Inbound -Action Allow -Program $node -Profile Any | Out-Null
`;
  return runPs1(path.join(dataDir, 'runtime', 'firewall.ps1'), body, { elevated: true });
}

async function installShortcut({ dataDir, appDir, nodePath }) {
  const body = `
$desktop = [Environment]::GetFolderPath('Desktop')
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $desktop ${psStr(SHORTCUT_NAME + '.lnk')}))
$s.TargetPath = ${psStr(nodePath)}
$s.Arguments = ${psStr(`"${path.join(appDir, 'server.js')}" --open --data "${dataDir}"`)}
$s.WorkingDirectory = ${psStr(appDir)}
$s.IconLocation = ${psStr(path.join(appDir, 'public', 'icon.ico') + ',0')}
$s.Description = 'Пульт для музыки ВК с телефона'
$s.WindowStyle = 7
$s.Save()

# Автозапуск при входе в Windows: сервер и значок в трее, без окон.
$a = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Пульт ВК.lnk'))
$a.TargetPath = ${psStr(nodePath)}
$a.Arguments = ${psStr(`"${path.join(appDir, 'server.js')}" --autostart --data "${dataDir}"`)}
$a.WorkingDirectory = ${psStr(appDir)}
$a.IconLocation = ${psStr(path.join(appDir, 'public', 'icon.ico') + ',0')}
$a.WindowStyle = 7
$a.Save()
`;
  return runPs1(path.join(dataDir, 'runtime', 'shortcut.ps1'), body);
}

module.exports = { installFirewall, installShortcut, SHORTCUT_NAME };
