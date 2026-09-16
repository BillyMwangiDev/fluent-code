// --- Preview & visual check ----------------------------------------------------
import {api} from '../api';
import {navigate, refresh} from '../router';
import {prefs} from '../prefs';
import {h, markEl, button, askConfirm, showActionError, showNotice, actionErrorText, relativeTime, formatTokens, formatUsd, formatPercent, bytes, duration, providerLabel, providerColor, modelLinkDefaults, accountLabel, verificationPill, laneReady, quotaLabel, directoryField, pickDirectory, workspaceFolderName, segmented, isLive} from '../ui';
import {metricCard, sparklineChart, lineChart} from '../charts';

import {currentProject} from '../project-scope';
import type {RecipeDefinition, RecipeReceipt} from '../api';

export async function renderPreview(main: HTMLElement) {
  const previewSessions = await api.listSessions();
  const project = currentProject(prefs.workspacePath, previewSessions);
  let recipes: RecipeDefinition[] = [];
  let receipts: RecipeReceipt[] = [];
  let recipeError: string | undefined;
  if (project) {
    try {
      [recipes, receipts] = await Promise.all([api.listRecipes(project), api.recipeReceipts(project)]);
    } catch (error) {
      recipeError = error instanceof Error ? error.message : String(error);
    }
  }
  const stored = prefs.previewUrl;
  const urlInput = h('input', {type: 'url', value: stored ?? 'http://localhost:3000', placeholder: 'http://localhost:3000'});
  const open = h('button', {class: 'btn primary'}, ['open preview']);
  const status = h('p', {class: 'section-sub'}, [stored ? `last selected preview: ${stored}` : 'Choose one local origin to open in a guarded preview window. Fluent never proxies preview traffic.']);
  const previewNotice = h('div', {class: 'preview-empty'}, [
    h('strong', {}, ['local preview opens in a guarded window']),
    h('p', {}, ['The window allows only the exact loopback origin you select. Its redirects and pop-ups cannot leave that origin.'])
  ]);
  open.addEventListener('click', async () => {
    const value = urlInput.value.trim();
    open.disabled = true;
    try {
      const origin = await api.openEmbeddedContent('preview', value);
      prefs.previewUrl = origin;
      status.textContent = `preview open at ${origin}`;
      status.className = 'success';
    } catch (error) {
      status.textContent = `for safety, ${actionErrorText(error)}`;
      status.className = 'error';
    } finally {
      open.disabled = false;
    }
  });
  const inspect = h('button', {class: 'btn'}, ['create visual-check task']);
  inspect.addEventListener('click', () => navigate({name: 'design'}));
  const recipeCard = h('div', {class: 'card'}, [
    h('h3', {}, ['reviewed project recipes']),
    h('p', {class: 'section-sub'}, [project
      ? 'Recipes are read from fluent.recipe.json. Running one always requires a one-time approval and records a redacted receipt.'
      : 'Start a project session before Fluent can read its fluent.recipe.json.'])
  ]);
  const recipeOutput = h('div', {});
  if (recipeError) {
    recipeCard.append(h('p', {class: 'error'}, [recipeError]));
  } else if (!project || recipes.length === 0) {
    recipeCard.append(h('p', {class: 'section-sub'}, [project ? 'No fluent.recipe.json recipes were found.' : 'No project is active.']));
  } else {
    for (const recipe of recipes) {
      const execute = h('button', {class: 'btn', type: 'button'}, ['run recipe']);
      execute.addEventListener('click', async () => {
        if (!(await askConfirm({title: `run recipe “${recipe.name}”`, body: `Fluent will run this exact command from ${project}.`, detail: recipe.command, confirmLabel: 'run recipe'}))) return;
        execute.disabled = true;
        recipeOutput.innerHTML = '';
        try {
          const receipt = await api.executeRecipe(project, recipe);
          receipts = [receipt, ...receipts].slice(0, 8);
          recipeOutput.append(h('div', {class: 'card'}, [
            h('h3', {}, [`recipe ${receipt.status}`]),
            h('p', {class: receipt.status === 'passed' ? 'success' : 'error'}, [`${receipt.name} · ${(receipt.durationMs / 1000).toFixed(1)}s · exit ${receipt.exitCode ?? 'unknown'}`]),
            h('pre', {class: 'diff'}, [receipt.output || 'Recipe produced no output.'])
          ]));
        } catch (error) {
          recipeOutput.append(h('p', {class: 'error'}, [error instanceof Error ? error.message : String(error)]));
        } finally {
          execute.disabled = false;
        }
      });
      recipeCard.append(h('div', {class: 'option-row'}, [h('div', {}, [h('div', {class: 'label'}, [recipe.name]), h('div', {class: 'meta'}, [recipe.description ?? recipe.command]), h('div', {class: 'section-sub'}, [`timeout ${(recipe.timeoutMs / 1000).toFixed(0)}s`])]), execute]));
    }
  }
  if (receipts.length > 0) {
    recipeCard.append(h('p', {class: 'section-sub'}, [`Latest receipt: ${receipts[0]!.name} · ${receipts[0]!.status} · ${new Date(receipts[0]!.startedAt).toLocaleString()}`]));
  }
  main.append(
    h('div', {class: 'toolbar'}, [
      h('div', {}, [h('h1', {class: 'section-title'}, [markEl(), 'preview & visual check']), status]),
      inspect
    ]),
    h('div', {class: 'field preview-controls'}, [urlInput, open]),
    previewNotice,
    recipeCard,
    recipeOutput
  );
}
