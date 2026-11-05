import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

if (!process.env.LANSW_EXE || !process.env.LANSW_BROWSER_PATH) throw new Error('Set LANSW_EXE and LANSW_BROWSER_PATH to the release executable and installed browser.');
const child=spawn(process.execPath,['--test','--test-name-pattern=gameFocusPauses','tests/e2e/mesh.spec.js'],{
  cwd:fileURLToPath(new URL('..',import.meta.url)),windowsHide:true,stdio:'inherit',
  env:{...process.env,LANSW_FIXED_HARDWARE_PERFORMANCE:'1'},
});
child.on('error',()=>{process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
