import { TestBed } from '@angular/core/testing';
import {
  ALICE,
  ALICE_BRUNO,
  BRUNO,
  aliceBrunoChat,
  answer,
  enterTestSession,
  refuse,
} from '@/core/hub/testing';
import { SEARCH_DELAY_MS } from './directory-store';
import { SearchStore } from './search-store';

const DIEGO = { username: 'diego', displayName: 'Diego', online: true, version: 4 };
const GROUP = {
  conversationId: 'g:1',
  type: 'group',
  name: 'SD',
  members: [ALICE, BRUNO],
  joinedAt: 500,
};

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
    // In the order of the list: the group, without messages, comes first.
    expect(search.results().conversations.map((c) => c.conversationId)).toEqual([
      'g:1',
      ALICE_BRUNO,
    ]);
    expect(search.results().people).toEqual([DIEGO]);
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
