const fs = require('fs');
const path = require('path');
const base = path.join(__dirname, '../supabase/functions/payday-api');
const engine = fs.readFileSync(path.join(base, 'game-engine.ts'), 'utf8');
const index = fs.readFileSync(path.join(base, 'index.ts'), 'utf8');
const bundled = index.replace(/import \{ GameEngine \} from "\.\/game-engine\.ts";\r?\n/, engine + '\n');
fs.writeFileSync(path.join(base, 'index.bundle.ts'), bundled);
fs.writeFileSync(path.join(__dirname, 'edge-bundle.ts'), bundled);
console.log('bundled', bundled.length);
