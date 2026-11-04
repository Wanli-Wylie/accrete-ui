// Where a Workspace keeps things, from its own Kernel. `config resolve` writes nothing.
import { execFile } from 'node:child_process';
import { join } from 'node:path';

export function resolveWorkspace(root) {
  const kernel = join(root, '.accrete/bin/accrete');
  return new Promise((resolve) => {
    execFile(kernel, ['--project', root, 'config', 'resolve', '--json'], { timeout: 10000 }, (err, stdout) => {
      if (!err) return resolve({ ...JSON.parse(stdout), kernel });
      // No Kernel on this host yet: the default roots, and no local state to read.
      resolve({
        project_root: root,
        kernel: null,
        error: err.message,
        local_state: null,
        paths: {
          memory: join(root, 'memory'),
          metadata: join(root, '.accrete/objects'),
          results: join(root, 'results'),
          scratch: join(root, 'scratch'),
          tool_sources: join(root, 'tools'),
        },
      });
    });
  });
}
