export interface ProcessIdentity {
    readonly pid: number;
    readonly ppid: number;
    readonly pgid: number;
    readonly started: string;
    readonly state: string;
}
export declare function parseProcessSnapshot(output: string): Map<number, ProcessIdentity>;
export declare class OwnedProcessTree {
    private readonly rootPid;
    private readonly guardianPid;
    private readonly owned;
    private rootIdentity;
    private groupRetired;
    constructor(rootPid: number, guardianPid: number);
    get rootObserved(): boolean;
    observe(snapshot: ReadonlyMap<number, ProcessIdentity>): void;
    liveMembers(snapshot: ReadonlyMap<number, ProcessIdentity>): ProcessIdentity[];
}
