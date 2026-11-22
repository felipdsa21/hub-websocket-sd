import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeStore } from './theme-store';

describe('ThemeStore', () => {
  const originalMatchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', originalMatchMedia);
    } else {
      delete (window as { matchMedia?: unknown }).matchMedia;
    }
  });

  it('defaults to system preference and toggles between dark and light with persistence', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(ThemeStore);
    const root = TestBed.inject(DOCUMENT).documentElement;

    expect(store.preference()).toBe('system');
    expect(root.classList.contains('theme-dark')).toBe(false);
    expect(root.classList.contains('theme-light')).toBe(false);

    store.toggle();
    expect(store.preference()).toBe('dark');
    expect(store.isDark()).toBe(true);
    expect(root.classList.contains('theme-dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    store.toggle();
    expect(store.preference()).toBe('light');
    expect(store.isDark()).toBe(false);
    expect(root.classList.contains('theme-light')).toBe(true);
    expect(root.classList.contains('theme-dark')).toBe(false);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    store.set('system');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
    expect(root.classList.contains('theme-light')).toBe(false);
    expect(root.classList.contains('theme-dark')).toBe(false);
  });

  it('restores a stored theme on initialization and syncs across tabs via storage event', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    TestBed.configureTestingModule({});
    const store = TestBed.inject(ThemeStore);
    const root = TestBed.inject(DOCUMENT).documentElement;

    expect(store.preference()).toBe('dark');
    expect(store.isDark()).toBe(true);
    expect(root.classList.contains('theme-dark')).toBe(true);

    window.dispatchEvent(
      new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }),
    );
    expect(store.preference()).toBe('light');
    expect(store.isDark()).toBe(false);
    expect(root.classList.contains('theme-light')).toBe(true);

    window.dispatchEvent(
      new StorageEvent('storage', {
        key: THEME_STORAGE_KEY,
        newValue: 'dark',
        storageArea: sessionStorage,
      }),
    );
    expect(store.preference()).toBe('light');

    localStorage.removeItem(THEME_STORAGE_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    expect(store.preference()).toBe('system');
    expect(root.classList.contains('theme-light')).toBe(false);
  });

  it('tracks system preference via matchMedia and handles missing or legacy implementations', () => {
    let listener: ((event: MediaQueryListEvent) => void) | undefined;
    const removeEventListener = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => {
          listener = cb;
        },
        removeEventListener,
      }),
    });

    TestBed.configureTestingModule({});
    const store = TestBed.inject(ThemeStore);
    expect(store.isDark()).toBe(true);

    listener?.({ matches: false } as MediaQueryListEvent);
    expect(store.isDark()).toBe(false);

    TestBed.resetTestingModule();
    expect(removeEventListener).toHaveBeenCalledOnce();

    // Legacy MediaQueryList (addListener/removeListener only) and undefined matchMedia return.
    const removeListener = vi.fn();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: false,
        addListener: (cb: (event: MediaQueryListEvent) => void) => {
          listener = cb;
        },
        removeListener,
      }),
    });

    TestBed.configureTestingModule({});
    const legacyStore = TestBed.inject(ThemeStore);
    listener?.({ matches: true } as MediaQueryListEvent);
    expect(legacyStore.isDark()).toBe(true);
    TestBed.resetTestingModule();
    expect(removeListener).toHaveBeenCalledOnce();

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => undefined,
    });
    TestBed.configureTestingModule({});
    expect(TestBed.inject(ThemeStore).isDark()).toBe(false);
  });
});
