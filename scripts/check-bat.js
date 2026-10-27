// Проверка bat-файлов перед коммитом: node scripts/check-bat.js
// У каждого goto/call — ровно одна метка, на каждую метку кто-то переходит, все строки с CRLF
// (cmd.exe на LF-строках ломается, а raw-ссылка GitHub отдаёт файл как есть).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = process.argv.slice(2).length ? process.argv.slice(2) : fs.readdirSync(root).filter((f) => f.endsWith('.bat')).map((f) => path.join(root, f));
let failed = false;

for (const file of files) {
  const raw = fs.readFileSync(file);
  const text = raw.toString('utf8');
  const lines = text.split('\r\n');
  const problems = [];
  const lfOnly = (text.match(/\n/g) || []).length - (text.match(/\r\n/g) || []).length;
  if (lfOnly) problems.push(`${lfOnly} строк без CR`);

  const labels = new Map();
  const jumps = [];
  lines.forEach((line, i) => {
    const m = line.match(/^\s*:([A-Za-z_]\w*)\s*$/);
    if (m) labels.set(m[1].toLowerCase(), [...(labels.get(m[1].toLowerCase()) || []), i + 1]);
    for (const j of line.matchAll(/\b(?:goto|call)\s+:(\w+)/gi)) jumps.push([i + 1, j[1].toLowerCase()]);
  });
  for (const [n, t] of jumps) if (t !== 'eof' && !labels.has(t)) problems.push(`строка ${n}: goto :${t} — такой метки нет`);
  for (const [t, ns] of labels) {
    if (ns.length > 1) problems.push(`метка :${t} объявлена ${ns.length} раза (строки ${ns.join(', ')})`);
    if (!jumps.some(([, j]) => j === t)) problems.push(`метка :${t} (строка ${ns[0]}) — на неё никто не переходит`);
  }

  console.log(path.basename(file), problems.length ? '— ПРОБЛЕМЫ:' : '— OK');
  for (const p of problems) console.log('   ' + p);
  if (problems.length) failed = true;
}
process.exit(failed ? 1 : 0);
