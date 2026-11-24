import { DOCUMENT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY, ThemeStore } from './theme-store';

describe('ThemeStore', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('theme-dark', 'theme-light');
  });

  it('defaults to system preference and persists light or dark', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(ThemeStore);
    const root = TestBed.inject(DOCUMENT).documentElement;

    expect(store.preference()).toBe('system');
    expect(root.classList.contains('theme-dark')).toBe(false);
    expect(root.classList.contains('theme-light')).toBe(false);

    store.set('dark');
    expect(store.preference()).toBe('dark');
    expect(root.classList.contains('theme-dark')).toBe(true);
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    store.set('light');
    expect(store.preference()).toBe('light');
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
    expect(root.classList.contains('theme-dark')).toBe(true);

    window.dispatchEvent(
      new StorageEvent('storage', { key: THEME_STORAGE_KEY, newValue: 'light' }),
    );
    expect(store.preference()).toBe('light');
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
});
