// The prompts Fluent composes for lanes. Kept free of DOM so their wording is testable and so the
// workspace, the sidebar, and the launch sheet send exactly the same brief for the same ticket.
import type {CoordinationState} from './api';

export type Ticket = CoordinationState['tasks'][number];

/** A clean, accountable brief for one ticket: the project direction once, then only this ticket.
 * This deliberately avoids pasting every prior conversation into every new provider session. */
export function ticketPrompt(task: Ticket, state: Pick<CoordinationState, 'masterBrief' | 'tasks'>): string {
  // The first line names the lane everywhere Fluent shows it, so it is the ticket, not the role.
  return [
    `Ticket: ${task.title}`,
    `You are the ${task.role || 'implementation'} specialist for this project.`,
    '',
    'Project direction:',
    state.masterBrief || 'No master brief has been set. Work only from the ticket and inspect the repository before changing files.',
    '',
    `Assigned ticket: ${task.title}`,
    task.description ? `Ticket details:\n${task.description}` : 'Ticket details: inspect the relevant code and make the smallest complete change.',
    ...(task.dependsOn?.length ? [
      `Prerequisites: ${task.dependsOn.map(id => {
        const dependency = state.tasks.find(candidate => candidate.id === id);
        return dependency ? `${dependency.title} (${dependency.status})` : `${id.slice(0, 8)} (missing)`;
      }).join(', ')}`
    ] : []),
    ...(task.designHandoff ? [
      '',
      'Design-to-build handoff:',
      task.designHandoff.sourceRef ? `Source mapping: ${task.designHandoff.sourceRef}` : '',
      task.designHandoff.componentSpec ? `Component specification: ${task.designHandoff.componentSpec}` : '',
      task.designHandoff.tokenSpec ? `Token specification: ${task.designHandoff.tokenSpec}` : '',
      task.designHandoff.previewUrl ? `Local preview: ${task.designHandoff.previewUrl}` : '',
      task.designHandoff.implementationPaths?.length ? `Intended implementation paths (claim before editing): ${task.designHandoff.implementationPaths.join(', ')}` : ''
    ].filter(Boolean) : []),
    '',
    'Keep your context focused on this ticket. Coordinate file claims and handoffs through Fluent when needed; do not take unrelated work. Before reporting completion, run the relevant checks and state changed files, verification, and any handoff needed.'
  ].join('\n');
}

export function plannerPrompt(specPath: string, masterBrief: string | undefined): string {
  return [
    `Plan spec: ${specPath.split(/[\\/]/).filter(Boolean).at(-1) ?? specPath}`,
    'You are the master orchestration planner for this project.',
    '',
    `Read this local specification file: ${specPath}`,
    'If the path is inaccessible, say so and ask for the relevant text rather than guessing.',
    '',
    'Project direction:',
    masterBrief || 'No master brief has been saved yet.',
    '',
    'Break the specification into small, independently verifiable Kanban tickets. For each, recommend a role and provider, call out file or dependency risks, and avoid doing implementation yourself. Use Fluent coordination tools to create the tickets when available; otherwise produce the numbered breakdown for the user to review.'
  ].join('\n');
}

/** Which tickets block this one: every prerequisite that is missing or not yet done. */
export function ticketBlockers(task: Ticket, tasks: readonly Ticket[]): Array<Ticket | undefined> {
  return (task.dependsOn ?? []).map(id => tasks.find(candidate => candidate.id === id)).filter(dependency => !dependency || dependency.status !== 'done');
}
