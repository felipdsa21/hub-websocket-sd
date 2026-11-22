import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { ConversationsStore } from '@/core/state/conversations-store';
import { SessionStore } from '@/core/state/session-store';
import { ConversationList } from './conversation-list';

describe('ConversationList', () => {
  let component: ConversationList;
  let fixture: ComponentFixture<ConversationList>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConversationList],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(ConversationList);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('prevents keyboard focus and navigation on dimmed offline conversations (M2)', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ConversationList],
      providers: [provideRouter([]), ...provideTestFixtures({ scenarios: ['sem-conexao'] })],
    }).compileComponents();

    await TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
    const conversations = TestBed.inject(ConversationsStore);
    const [first, second] = conversations.sorted();
    conversations.open(first!.conversationId);

    const offlineFixture = TestBed.createComponent(ConversationList);
    await offlineFixture.whenStable();
    const links = [
      ...(offlineFixture.nativeElement as HTMLElement).querySelectorAll<HTMLAnchorElement>(
        'a[mat-list-item]',
      ),
    ];
    const openedLink = links[0]!;
    const dimmedLink = links[1]!;

    expect(openedLink.getAttribute('href')).toBe(`/c/${first!.conversationId}`);
    expect(openedLink.getAttribute('tabindex')).not.toBe('-1');
    expect(openedLink.getAttribute('aria-disabled')).not.toBe('true');

    expect(second).toBeDefined();
    expect(dimmedLink.getAttribute('href')).toBeNull();
    expect(dimmedLink.getAttribute('tabindex')).toBe('-1');
    expect(dimmedLink.getAttribute('aria-disabled')).toBe('true');

    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
    dimmedLink.click();
    expect(navigate).not.toHaveBeenCalled();
  });
});
