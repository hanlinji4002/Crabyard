import { appState } from '../../state.js';
import { t } from '../../i18n.js';
import type { SectionController } from './section.js';
import { toggleRow } from './shared.js';

const GITHUB_URL = 'https://github.com/elirantutia/vibeyard';
const ISSUES_URL = 'https://github.com/elirantutia/vibeyard/issues';

export function createAboutSection(): SectionController {
  let debugModeCheckbox: HTMLInputElement | null = null;

  return {
    render(container) {
      const aboutDiv = document.createElement('div');
      aboutDiv.className = 'about-section';

      const appName = document.createElement('div');
      appName.className = 'about-app-name';
      appName.textContent = t('about.appName');

      const versionLine = document.createElement('div');
      versionLine.className = 'about-version';
      versionLine.textContent = t('about.versionLoading');

      // No "Check for Updates" row: this custom fork has auto-update switched off
      // in the main process (src/main/auto-updater.ts), so a check could only
      // ever claim "You're up to date".

      const linksDiv = document.createElement('div');
      linksDiv.className = 'about-links';

      const ghLink = document.createElement('a');
      ghLink.className = 'about-link';
      ghLink.textContent = t('about.githubLink');
      ghLink.href = '#';
      ghLink.addEventListener('click', (e) => { e.preventDefault(); window.vibeyard.app.openExternal(GITHUB_URL); });

      const bugLink = document.createElement('a');
      bugLink.className = 'about-link';
      bugLink.textContent = t('about.bugLink');
      bugLink.href = '#';
      bugLink.addEventListener('click', (e) => { e.preventDefault(); window.vibeyard.app.openExternal(ISSUES_URL); });

      linksDiv.appendChild(ghLink);
      linksDiv.appendChild(bugLink);

      const communityDiv = document.createElement('div');
      communityDiv.className = 'about-community';
      const contributeLink = document.createElement('a');
      contributeLink.className = 'about-link';
      contributeLink.href = '#';
      contributeLink.textContent = t('about.contributeLink');
      contributeLink.addEventListener('click', (e) => { e.preventDefault(); window.vibeyard.app.openExternal(GITHUB_URL); });
      communityDiv.append(
        t('about.communityPrefix'),
        contributeLink,
        t('about.communitySuffix'),
      );

      const debug = toggleRow('pref-debug-mode', t('about.debugModeLabel'), appState.preferences.debugMode);
      const debugRow = debug.row;
      debugModeCheckbox = debug.checkbox;

      aboutDiv.appendChild(appName);
      aboutDiv.appendChild(versionLine);
      aboutDiv.appendChild(linksDiv);
      aboutDiv.appendChild(communityDiv);
      aboutDiv.appendChild(debugRow);
      container.appendChild(aboutDiv);

      window.vibeyard.app.getVersion().then((ver) => {
        versionLine.textContent = t('about.versionLoaded', { ver });
      });
    },

    save() {
      if (debugModeCheckbox && debugModeCheckbox.checked !== appState.preferences.debugMode) {
        appState.setPreference('debugMode', debugModeCheckbox.checked);
        window.vibeyard.menu.rebuild(debugModeCheckbox.checked);
      }
    },
  };
}
