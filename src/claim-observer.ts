import {EventEmitter} from 'node:events';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import type {CoordinationManager} from './coordination.js';
import type {ClaimConflict, RankedConflict} from './daemon-protocol.js';

const run = promisify(execFile);

/** How far back to look when deciding which files everything touches. */
const hotspotHistoryDepth = 400;
/** A path in the busiest this fraction of changed files counts as a collision hotspot. */
const hotspotShare = 0.05;
const hotspotTtlMs = 60 * 60_000;

export type Lane = {sessionId: string; project: string; directory: string};
export type LaneProjectValidator = (project: string, sessionId: string) => unknown;

/**
 * Parses `git status --porcelain` into the paths a lane has actually touched. Renames report both
 * sides; the destination is what the lane now owns.
 */
export function changedPathsFrom(porcelain: string) {
  const paths: string[] = [];
  for (const line of porcelain.split('\n')) {
    if (!line.trim()) continue;
    const entry = line.slice(3);
    const renamed = entry.split(' -> ');
    const path = (renamed[1] ?? renamed[0] ?? '').trim();
    // Git quotes paths containing unusual characters; the quotes are not part of the path.
    paths.push(path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path);
  }
  return paths.filter(Boolean);
}

/**
 * Watches what lanes are really editing and turns it into coordination state.
 *
 * A declared claim depends on an agent choosing to announce its intent. This needs nothing from
 * the agent: it reads each lane's own working tree and records the overlap the moment two lanes'
 * real edits intersect — which is the whole point, because the alternative is discovering it at
 * merge time, where the field measures a 27.67% conflict rate and 41.7% between lanes running
 * different providers (docs/research/2026-09-13-agent-orchestration.md §2.3).
 *
 * Emits 'conflicts' (project, RankedConflict[]) only when the set actually changes, so a quiet
 * sweep stays quiet.
 */
export class ClaimObserver extends EventEmitter {
  private readonly hotspots = new Map<string, {paths: Set<string>; computedAt: number}>();
  private readonly lastReported = new Map<string, string>();

  constructor(
    private readonly coordination: CoordinationManager,
    /** The daemon supplies session/project membership; standalone analysis tests need no manager. */
    private readonly requireLaneInProject: LaneProjectValidator = () => undefined
  ) {
    super();
  }

  async sweep(lanes: readonly Lane[]) {
    const touched = new Set<string>();
    for (const lane of lanes) {
      const paths = await this.changedPaths(lane.directory);
      if (paths === undefined) continue;
      this.requireLaneInProject(lane.project, lane.sessionId);
      await this.coordination.observe(lane.project, lane.sessionId, paths);
      touched.add(lane.project);
    }

    const byProject = new Map<string, RankedConflict[]>();
    for (const project of touched) {
      const ranked = await this.rank(project, this.coordination.conflicts(project));
      byProject.set(project, ranked);
      // Compare on content, not identity: a sweep that finds the same overlaps is not news.
      const fingerprint = JSON.stringify(ranked.map(conflict => [conflict.path, conflict.claimedPath, conflict.sessionId]));
      if (this.lastReported.get(project) === fingerprint) continue;
      this.lastReported.set(project, fingerprint);
      this.emit('conflicts', project, ranked);
    }
    return byProject;
  }

  /**
   * Orders conflicts by how much trouble they are likely to be. A collision on a file that every
   * feature touches — a route table, a config, a registry — is both the most common kind and the
   * most expensive to discover late, so it is surfaced first.
   */
  async rank(project: string, conflicts: readonly ClaimConflict[]): Promise<RankedConflict[]> {
    const hotspots = await this.hotspotPaths(project);
    return conflicts
      .map(conflict => ({...conflict, hotspot: hotspots.has(conflict.path) || hotspots.has(conflict.claimedPath)}))
      .sort((left, right) => Number(right.hotspot) - Number(left.hotspot));
  }

  /**
   * The project's own collision hotspots, derived from its history rather than from a guessed list
   * of filenames: what "everything touches" differs per repository, and the repository already
   * knows.
   */
  async hotspotPaths(project: string) {
    const cached = this.hotspots.get(project);
    if (cached && Date.now() - cached.computedAt < hotspotTtlMs) return cached.paths;

    const paths = new Set<string>();
    try {
      const {stdout} = await run('git', ['-C', project, 'log', `-n${hotspotHistoryDepth}`, '--name-only', '--pretty=format:', '--no-merges'], {timeout: 15_000, maxBuffer: 8_000_000});
      const counts = new Map<string, number>();
      for (const line of stdout.split('\n')) {
        const path = line.trim();
        if (path) counts.set(path, (counts.get(path) ?? 0) + 1);
      }
      const ordered = [...counts.entries()].sort((left, right) => right[1] - left[1]);
      // A file changed only once or twice is not a hotspot however short the history is.
      for (const [path, count] of ordered.slice(0, Math.max(1, Math.ceil(ordered.length * hotspotShare)))) {
        if (count > 2) paths.add(path);
      }
    } catch {
      // A project with no history yet simply has no hotspots.
    }

    this.hotspots.set(project, {paths, computedAt: Date.now()});
    return paths;
  }

  forgetProject(project: string) {
    this.hotspots.delete(project);
    this.lastReported.delete(project);
  }

  /** `undefined` means the lane's tree could not be read at all — leave its claims alone rather
   * than concluding it has stopped touching everything it had touched. */
  private async changedPaths(directory: string) {
    try {
      const {stdout} = await run('git', ['-C', directory, 'status', '--porcelain'], {timeout: 8_000, maxBuffer: 4_000_000});
      return changedPathsFrom(stdout);
    } catch {
      return undefined;
    }
  }
}
