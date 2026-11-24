import { TestBed } from '@angular/core/testing';
import { CARLA, aliceBrunoChat, answer, enterTestSession } from '@/core/hub/testing';
import { DirectoryStore } from './directory-store';

describe('DirectoryStore', () => {
  it('finds people to choose, including those with a direct chat', async () => {
    const socket = await enterTestSession();
    const directory = TestBed.inject(DirectoryStore);
    const finding = directory.findPeople('  b  ');
    expect(socket.last()).toMatchObject({ action: 'search', query: 'b' });

    answer(socket, { conversations: [aliceBrunoChat()], people: [CARLA] });

    expect((await finding).map((u) => u.username)).toEqual(['bruno', 'carla']);
    expect(directory.get('carla')).toEqual(CARLA);
  });
});
