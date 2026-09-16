// --- Themes & appearance -----------------------------------------------------
import {applyAppearance, prefs, resolvedMode, type Appearance} from '../prefs';
import {refresh} from '../router';
import {h, markEl, segmented} from '../ui';

export async function renderThemes(main: HTMLElement) {
  const currentMode = resolvedMode();
  const darkThemes = ['Fluent Dark', 'Midnight', 'Ember', 'Nord Dark', 'High Contrast Dark'];
  const lightThemes = ['Fluent Light', 'Paper', 'Nord Light', 'High Contrast Light'];
  const appearanceRow = segmented<Appearance>([{id: 'system', label: 'system'}, {id: 'light', label: 'light'}, {id: 'dark', label: 'dark'}], prefs.appearance, next => {
    prefs.appearance = next;
    applyAppearance();
    void refresh();
  });
  const names = currentMode === 'dark' ? darkThemes : lightThemes;
  const bundles = prefs.bundles;
  const themeCards = h('div', {class: 'theme-grid'});
  for (const name of names) {
    const card = h('button', {type: 'button', class: `theme-card${bundles[currentMode] === name ? ' selected' : ''}`, 'aria-pressed': bundles[currentMode] === name ? 'true' : 'false'}, [
      h('span', {class: 'theme-swatches', 'data-bundle': name}, [h('i'), h('i'), h('i'), h('i')]),
      h('strong', {}, [name]),
      h('span', {class: 'muted'}, ['palette · ANSI · syntax · density'])
    ]);
    card.addEventListener('click', () => {
      prefs.bundles = {...bundles, [currentMode]: name};
      applyAppearance();
      void refresh();
    });
    themeCards.append(card);
  }
  main.append(
    h('h1', {class: 'section-title'}, [markEl(), 'themes & appearance']),
    h('p', {class: 'section-sub'}, ['appearance mode is separate from each mode’s saved theme bundle. Light and dark themes never mix.']),
    h('label', {class: 'field-label'}, ['appearance mode']),
    appearanceRow,
    h('p', {class: 'section-sub'}, [prefs.appearance === 'system' ? `system currently resolves to ${currentMode}; dark → ${bundles.dark}, light → ${bundles.light}` : `${currentMode} themes`]),
    themeCards,
    h('div', {class: 'card'}, [h('h3', {}, ['terminal preview']), h('pre', {class: 'theme-preview'}, ['› pnpm check\n✓ typecheck passed\nconst agent = await run()'])])
  );
}
