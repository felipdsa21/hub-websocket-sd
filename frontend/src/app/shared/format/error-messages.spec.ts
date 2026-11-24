import { addMembersNotice } from '@/shared/format/error-messages';

describe('addMembersNotice', () => {
  const nameOf = (u: string) => ({ bruno: 'Bruno Lima', gabriel: 'Gabriel Nunes' })[u] ?? u;

  it('names who went in and why the others failed, as in the design', () => {
    expect(
      addMembersNotice(
        {
          added: ['bruno'],
          failed: [{ username: 'gabriel', reason: { code: 'invalidOperation', message: '' } }],
        },
        nameOf,
      ),
    ).toBe('Bruno Lima foi adicionado. Gabriel Nunes já é membro do grupo.');
  });

  it('says nothing when everyone was added', () => {
    expect(addMembersNotice({ added: ['bruno'], failed: [] }, nameOf)).toBeNull();
  });
});
