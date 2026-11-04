// The process table and open files, from ps and lsof. macOS has no /proc.
import { execFile } from 'node:child_process';

// Both exit non-zero when a listed pid has gone, and what they printed is still good.
function run(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { env: { ...process.env, LC_ALL: 'C' }, maxBuffer: 64 * 1024 * 1024, timeout: 15000 }, (_err, stdout) => {
      resolve(stdout ?? '');
    });
  });
}

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s(.*)$/;

export function parsePs(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const m = PS_LINE.exec(line);
    if (!m) continue;
    rows.push({
      uid: Number(m[1]),
      pid: Number(m[2]),
      ppid: Number(m[3]),
      cpu: Number(m[4]),
      rss: Number(m[5]) * 1024,
      state: m[6],
      tty: m[7],
      startedAt: Date.parse(m[8]),
      command: m[9].trim(),
    });
  }
  return rows;
}

let lastTable = null;

// A caller that does not need the very latest can share the table another poll just read.
export async function listProcesses({ maxAgeMs = 0 } = {}) {
  if (lastTable && Date.now() - lastTable.at <= maxAgeMs) return lastTable.rows;
  const text = await run('ps', ['-axww', '-o', 'uid=,pid=,ppid=,pcpu=,rss=,state=,tty=,lstart=,command=']);
  lastTable = { at: Date.now(), rows: parsePs(text) };
  return lastTable.rows;
}

// lsof writes non-ASCII bytes of a name as \xHH under LC_ALL=C.
function decodeName(name) {
  if (!name.includes('\\x')) return name;
  const bytes = name.replace(/\\x([0-9a-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return Buffer.from(bytes, 'latin1').toString('utf8');
}

// Output of `lsof -F`, one field per line, a p line opening each process and an
// f line opening each of its files. Returns pid -> [{ fd, access, type, size, name }].
export function parseLsof(text) {
  const byPid = new Map();
  let files = null;
  let file = null;
  for (const line of text.split('\n')) {
    const value = line.slice(1);
    switch (line[0]) {
      case 'p':
        files = [];
        byPid.set(Number(value), files);
        break;
      case 'f':
        file = { fd: value };
        files?.push(file);
        break;
      case 'a':
        if (file) file.access = value;
        break;
      case 't':
        if (file) file.type = value;
        break;
      case 's':
        if (file) file.size = Number(value);
        break;
      case 'n':
        if (file) file.name = decodeName(value);
        break;
    }
  }
  return byPid;
}

// pid -> working directory, for the given pids only.
export async function workingDirectories(pids) {
  const cwds = new Map();
  if (pids.length === 0) return cwds;
  const text = await run('lsof', ['-nP', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fpn']);
  for (const [pid, files] of parseLsof(text)) {
    if (files[0]?.name) cwds.set(pid, files[0].name);
  }
  return cwds;
}

// pid -> open files, for the given pids only.
export async function openFiles(pids) {
  if (pids.length === 0) return new Map();
  return parseLsof(await run('lsof', ['-nP', '-p', pids.join(','), '-Fpfatsn']));
}

// Which agent a process is, by its executable. Processes retitle themselves, so
// `claude` may be all the table shows.
export function agentOf(command) {
  const m =
    /^(?:\S*\/)?(?:node\s+(?:\S*\/)?)?(claude|codex)(?:\s|$)/.exec(command) ??
    /^(?:\S*\/)?node\s+\S*\/(claude)-code\/cli\.m?js(?:\s|$)/.exec(command);
  return m ? m[1] : null;
}
