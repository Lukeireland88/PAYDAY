const fs = require('fs');
const path = require('path');
const bundled = fs.readFileSync(path.join(__dirname, 'edge-bundle.ts'), 'utf8');
const payload = {
  name: 'payday-api',
  entrypoint_path: 'index.ts',
  verify_jwt: false,
  files: [{ name: 'index.ts', content: bundled }]
};
fs.writeFileSync(path.join(__dirname, 'deploy-bundle.json'), JSON.stringify(payload));
console.log('Wrote deploy-bundle.json', bundled.length, 'chars');
