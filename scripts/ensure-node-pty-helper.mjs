import {chmodSync, existsSync, statSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const helper = fileURLToPath(new URL(`../node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`, import.meta.url));
if (existsSync(helper)) {
  const mode = statSync(helper).mode;
  chmodSync(helper, mode | 0o111);
}
