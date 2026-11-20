// Syntax checks without a build step: server/demo modules, start.sh and the inline page script.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

run(process.execPath, ['--check', 'server.js']);
run(process.execPath, ['--check', 'demo.js']);
run('bash', ['-n', 'start.sh']);

// the UI lives in one <script> block of public/index.html
const html = readFileSync('public/index.html', 'utf8');
const script = html.split('<script>')[1]?.split('</script>')[0];
if (!script) throw new Error('No inline <script> found in public/index.html');
new Function(script); // throws on a syntax error

console.log('All checks passed');
