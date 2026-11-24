import { TestBed } from '@angular/core/testing';
import {
  ALICE_BRUNO,
  GROUP,
  aliceBrunoChat,
  answer,
  enterTestSession,
  refuse,
} from '@/core/hub/testing';
import { ConversationsStore } from './conversations-store';
import { SEARCH_DELAY_MS } from './directory-store';
import { SearchStore } from './search-store';

const DIEGO = { username: 'diego', displayName: 'Diego', online: true, version: 4 };
describe('SearchStore', () => {
  afterEach(() => vi.useRealTimers());

  it('waits for a pause in typing and keeps only the answer of the last search', async () => {
    const socket = await enterTestSession([GROUP, aliceBrunoChat()]);
    vi.useFakeTimers();
    const search = TestBed.inject(SearchStore);

    search.search('b');
    search.search('br');
    expect(search.status()).toBe('loading');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    const searches = () => socket.sent.filter((r) => r['action'] === 'search');
    expect(searches().map((r) => r['query'])).toEqual(['br']);

    answer(socket, { conversations: [aliceBrunoChat(), GROUP], people: [DIEGO] });
    await vi.advanceTimersByTimeAsync(0);

    expect(search.status()).toBe('done');
    // In the order of the list: the group, joined later, comes first.
    expect(search.results().conversations.map((c) => c.conversationId)).toEqual([
      'g:1',
      ALICE_BRUNO,
    ]);
    expect(search.results().people).toEqual([DIEGO]);
  });

  it('adds a found conversation missing from the list when kept', async () => {
    const socket = await enterTestSession([aliceBrunoChat()]);
    vi.useFakeTimers();
    const search = TestBed.inject(SearchStore);
    const conversations = TestBed.inject(ConversationsStore);

    search.search('sd');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    answer(socket, { conversations: [GROUP], people: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(conversations.get('g:1')).toBeUndefined();

    search.keep('g:1');

    expect(conversations.get('g:1')).toEqual(expect.objectContaining({ name: 'SD' }));
  });

  it('shows the error of a failed search', async () => {
    const socket = await enterTestSession();
    vi.useFakeTimers();
    const search = TestBed.inject(SearchStore);
    search.search('br');
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    refuse(socket, 'invalidRequest');
    await vi.advanceTimersByTimeAsync(0);
    expect(search.status()).toBe('error');

    search.retry();
    vi.advanceTimersByTime(SEARCH_DELAY_MS);
    expect(socket.last()).toMatchObject({ action: 'search', query: 'br' });
    answer(socket, { conversations: [], people: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(search.status()).toBe('done');
  });
});
