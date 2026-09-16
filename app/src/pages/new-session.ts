// New Session is the launch form as a page, with every option open. The same form backs the
// workspace's empty state and the `+ lanes` sheet.
import {launchForm, loadReadiness, runLaunch} from '../launch';
import {prefs} from '../prefs';
import {navigate} from '../router';
import {actionErrorText, h, markEl, showActionError} from '../ui';

export async function renderNewSession(main: HTMLElement) {
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'new session']),
    h('p', {class: 'section-sub'}, ['one brief, a count per provider, and a working directory. Lanes open in the workspace as they start.'])
  );
  try {
    const {readiness, chains} = await loadReadiness();
    const form = launchForm({
      directory: prefs.workspacePath,
      readiness,
      chains,
      variant: 'page',
      onCancel: () => navigate({name: 'sessions'}),
      onLaunch: async request => {
        const outcome = await runLaunch(request, readiness);
        if (outcome.failures.length) showActionError(new Error(`${outcome.failures.length} lane${outcome.failures.length === 1 ? '' : 's'} did not start — ${outcome.failures[0]}`));
        if (outcome.created.length === 1 && request.mode === 'delegate') navigate({name: 'active-session', sessionId: outcome.created[0]!.id});
        else navigate({name: 'orchestration', focus: outcome.created.length === 1 ? outcome.created[0]!.id : undefined});
      }
    });
    main.append(h('div', {class: 'launch-page'}, [form.el]));
    form.focus();
  } catch (error) {
    main.append(h('p', {class: 'error'}, [actionErrorText(error)]));
  }
}
