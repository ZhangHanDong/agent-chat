export interface ProcessIdentity {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly started: string;
  readonly state: string;
}

// Only ownership metadata is requested from ps; command lines and environments
// may contain credentials and are neither needed nor retained here.
export function parseProcessSnapshot(output: string): Map<number, ProcessIdentity> {
  const processes = new Map<number, ProcessIdentity>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const fields = line.trim().split(/\s+/u);
    if (fields.length !== 9 || !fields.slice(0, 3).every((field) => /^\d+$/u.test(field))) {
      throw new Error('process ownership snapshot is malformed');
    }
    const [pid, ppid, pgid] = fields.slice(0, 3).map(Number);
    const state = fields[8];
    if (!pid || ppid === undefined || pgid === undefined || !state || processes.has(pid)) {
      throw new Error('process ownership snapshot has invalid identities');
    }
    processes.set(pid, { pid, ppid, pgid, started: fields.slice(3, 8).join(' '), state });
  }
  if (!processes.size) throw new Error('process ownership snapshot is empty');
  return processes;
}

export class OwnedProcessTree {
  private readonly owned = new Map<number, ProcessIdentity>();
  private rootIdentity: ProcessIdentity | null = null;
  private groupRetired = false;

  constructor(private readonly rootPid: number, private readonly guardianPid: number) {}

  get rootObserved(): boolean { return this.rootIdentity !== null; }

  observe(snapshot: ReadonlyMap<number, ProcessIdentity>): void {
    const root = snapshot.get(this.rootPid);
    if (!this.rootIdentity && root?.ppid === this.guardianPid && root.pgid === this.rootPid) {
      this.rootIdentity = root;
      this.owned.set(root.pid, root);
    }
    if (!this.rootIdentity) return;
    // A reused leader PID is not our process group. Once absent, the original
    // group cannot become ours again merely by reusing the same numeric id.
    if (root && root.started !== this.rootIdentity.started) this.groupRetired = true;
    const group = [...snapshot.values()].filter((row) => row.pgid === this.rootPid);
    if (!group.length) this.groupRetired = true;
    if (!this.groupRetired) for (const row of group) this.owned.set(row.pid, row);

    let added = true;
    while (added) {
      added = false;
      for (const row of snapshot.values()) {
        if (this.owned.get(row.pid)?.started === row.started) continue;
        const parent = snapshot.get(row.ppid);
        // Birth identity prevents a reused former parent's PID from granting
        // authority over another process's descendants.
        if (parent && this.owned.get(parent.pid)?.started === parent.started) {
          this.owned.set(row.pid, row);
          added = true;
        }
      }
    }
  }

  liveMembers(snapshot: ReadonlyMap<number, ProcessIdentity>): ProcessIdentity[] {
    return [...snapshot.values()].filter((row) =>
      this.owned.get(row.pid)?.started === row.started && !row.state.startsWith('Z'));
  }
}
