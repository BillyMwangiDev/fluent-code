import {execFile} from 'node:child_process';
import {mkdir} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';
import {promisify} from 'node:util';

const run = promisify(execFile);

export type Worktree = {projectDirectory: string; path: string};

/**
 * Creates a detached checkout for one agent. Detached worktrees intentionally avoid making a
 * branch-name decision for the user; the agent can create a branch when it is ready to hand off.
 * They live beside the project, never inside it, so Git does not mistake a nested checkout for
 * ordinary project files.
 */
export class WorktreeManager {
  async create(directory: string, sessionId: string): Promise<Worktree> {
    const projectDirectory = (await run('git', ['-C', directory, 'rev-parse', '--show-toplevel'])).stdout.trim();
    if (!projectDirectory) throw new Error('Isolated agent sessions require a Git working tree');
    const path = join(process.env.FLUENT_WORKTREE_DIR ?? join(dirname(projectDirectory), '.fluent-worktrees'), basename(projectDirectory), sessionId);
    await mkdir(dirname(path), {recursive: true});
    try {
      await run('git', ['-C', projectDirectory, 'worktree', 'add', '--detach', path, 'HEAD']);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not create an isolated worktree: ${message}`);
    }
    return {projectDirectory, path};
  }

  async remove(projectDirectory: string, path: string) {
    await run('git', ['-C', projectDirectory, 'worktree', 'remove', '--force', path]);
  }
}
