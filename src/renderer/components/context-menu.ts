let activeMenu: HTMLElement | null = null;
let pendingCloseHandler: ((e: Event) => void) | null = null;

export interface MenuOption {
  label: string;
  action: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Draw a divider above this item. */
  separatorBefore?: boolean;
}

export function showContextMenu(x: number, y: number, options: MenuOption[]): void {
  if (pendingCloseHandler) {
    document.removeEventListener('click', pendingCloseHandler);
    document.removeEventListener('keydown', pendingCloseHandler);
    pendingCloseHandler = null;
  }

  hideContextMenu();

  const menu = document.createElement('div');
  menu.className = 'board-context-menu';

  for (const opt of options) {
    if (opt.separatorBefore) {
      const sep = document.createElement('div');
      sep.className = 'board-context-menu-separator';
      menu.appendChild(sep);
    }
    const item = document.createElement('div');
    item.className = 'board-context-menu-item';
    if (opt.danger) item.classList.add('danger');
    if (opt.disabled) item.classList.add('disabled');
    item.textContent = opt.label;
    if (!opt.disabled) {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        hideContextMenu();
        opt.action();
      });
    }
    menu.appendChild(item);
  }

  // Position, then clamp to the viewport once the real size is known (long
  // menus scroll — see max-height in context-menu.css).
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;

  document.body.appendChild(menu);
  activeMenu = menu;
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;

  // Close on next click or Escape
  const close = (e: Event) => {
    if (e instanceof KeyboardEvent && e.key !== 'Escape') return;
    hideContextMenu();
    document.removeEventListener('click', close);
    document.removeEventListener('keydown', close);
    pendingCloseHandler = null;
  };
  // Delay to avoid the triggering contextmenu click from immediately closing
  requestAnimationFrame(() => {
    document.addEventListener('click', close);
    document.addEventListener('keydown', close);
    pendingCloseHandler = close;
  });
}

export function hideContextMenu(): void {
  if (activeMenu) {
    activeMenu.remove();
    activeMenu = null;
  }
}
