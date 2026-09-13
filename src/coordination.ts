import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import type {CoordinationState} from './daemon-protocol.js';

export class CoordinationManager {
  private readonly states = new Map<string, CoordinationState>();
  private readonly stateFile: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(stateDirectory = process.env.FLUENT_STATE_DIR ?? join(process.cwd(), '.fluent')) {
    this.stateFile = join(stateDirectory, 'coordination.json');
  }

  async restore() {
    try {
      const parsed = JSON.parse(await readFile(this.stateFile, 'utf8')) as CoordinationState[];
      for (const state of parsed) this.states.set(state.project, state);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  get(project: string) {
    return this.ensure(project);
  }

  async task(project: string, title: string, sessionId?: string) {
    const state = this.ensure(project);
    state.tasks.unshift({id: randomUUID(), title, status: sessionId ? 'active' : 'todo', sessionId, createdAt: new Date().toISOString()});
    await this.persist();
    return state;
  }

  async updateTask(project: string, taskId: string, status: 'todo' | 'active' | 'done', sessionId?: string) {
    const state = this.ensure(project);
    const task = state.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Coordination task not found');
    task.status = status;
    task.sessionId = sessionId ?? task.sessionId;
    await this.persist();
    return state;
  }

  async claim(project: string, path: string, sessionId: string) {
    const state = this.ensure(project);
    const conflict = state.claims.find(claim => claim.path === path && claim.sessionId !== sessionId);
    if (!conflict) state.claims = [...state.claims.filter(claim => !(claim.path === path && claim.sessionId === sessionId)), {path, sessionId, createdAt: new Date().toISOString()}];
    await this.persist();
    return {state, conflict};
  }

  async releaseClaim(project: string, path: string, sessionId: string) {
    const state = this.ensure(project);
    const before = state.claims.length;
    state.claims = state.claims.filter(claim => !(claim.path === path && claim.sessionId === sessionId));
    if (state.claims.length === before) throw new Error('File claim not found for this agent');
    await this.persist();
    return state;
  }

  async decision(project: string, summary: string, sessionId?: string) {
    const state = this.ensure(project);
    state.decisions.unshift({id: randomUUID(), summary, sessionId, createdAt: new Date().toISOString()});
    await this.persist();
    return state;
  }

  async handoff(project: string, fromSessionId: string, toSessionId: string, summary: string) {
    const state = this.ensure(project);
    state.handoffs.unshift({id: randomUUID(), fromSessionId, toSessionId, summary, createdAt: new Date().toISOString(), status: 'open'});
    await this.persist();
    return state;
  }

  async acceptHandoff(project: string, handoffId: string) {
    const state = this.ensure(project);
    const handoff = state.handoffs.find(item => item.id === handoffId);
    if (!handoff) throw new Error('Coordination handoff not found');
    handoff.status = 'accepted';
    await this.persist();
    return state;
  }

  private ensure(project: string) {
    let state = this.states.get(project);
    if (!state) {
      state = {project, tasks: [], claims: [], decisions: [], handoffs: []};
      this.states.set(project, state);
    }
    return state;
  }

  private async persist() {
    const run = this.queue.then(async () => {
      await mkdir(dirname(this.stateFile), {recursive: true});
      const temporary = `${this.stateFile}.tmp`;
      await writeFile(temporary, JSON.stringify([...this.states.values()], null, 2));
      await rename(temporary, this.stateFile);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
