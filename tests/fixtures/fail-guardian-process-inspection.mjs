import childProcess from 'node:child_process';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

// Subprocess-only fault injection: the real guardian initially observes its
// runtime, then loses process-table inspection once the test writes this gate.
if (process.argv[1]?.endsWith('/runner-guardian.js')) {
  const execFile = childProcess.execFile;
  childProcess.execFile = function (file, args, options, callback) {
    if (file === '/bin/ps' && existsSync(process.env.FAKE_GUARDIAN_INSPECTION_FAILURE)) {
      queueMicrotask(() => callback(new Error('fixture process inspection unavailable'), '', ''));
      return;
    }
    return execFile.call(this, file, args, options, callback);
  };
  syncBuiltinESMExports();
}
