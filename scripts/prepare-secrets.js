const fs = require('fs');
const path = require('path');

const output = path.resolve(__dirname, '..', 'src', 'runtime-secrets.json');
let bundled = {};
try {
  bundled = JSON.parse(fs.readFileSync(output, 'utf8'));
} catch {}

const fromEnv = String(process.env.CURSEFORGE_API_KEY || '').trim();
const key = fromEnv || String(bundled.curseForgeApiKey || '').trim();

if (!key) {
  throw new Error('Bundled CurseForge API key is missing.');
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({ curseForgeApiKey: key }, null, 2)}\n`);
process.stdout.write('CurseForge runtime credentials ready.\n');
