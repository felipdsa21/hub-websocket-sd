import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Breakpoints } from '@/core/layout/breakpoints';
import { ConversationsStore } from '@/core/state/conversations-store';
import { MembersPage } from './members-page';

describe('MembersPage', () => {
  let component: MembersPage;
  let fixture: ComponentFixture<MembersPage>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MembersPage],
      providers: [provideRouter([])],
    }).compileComponents();

    fixture = TestBed.createComponent(MembersPage);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('conversationId', 'g:1');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('redirects to / on mobile when the user leaves or is removed from the group (B2)', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [MembersPage],
      providers: [
        provideRouter([]),
        {
          provide: Breakpoints,
          useValue: {
            compact: signal(true),
            wideList: signal(false),
            windowSize: signal<'compact' | 'medium' | 'expanded'>('compact'),
          },
        },
      ],
    }).compileComponents();

    const conversations = TestBed.inject(ConversationsStore);
    conversations.reset(
      [{ conversationId: 'g:1', type: 'group', name: 'SD', members: ['alice'], joinedAt: 1 }],
      new Map(),
    );
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);

    const mobileFixture = TestBed.createComponent(MembersPage);
    mobileFixture.componentRef.setInput('conversationId', 'g:1');
    await mobileFixture.whenStable();
    expect(navigate).not.toHaveBeenCalled();

    conversations.remove('g:1');
    await mobileFixture.whenStable();
    expect(navigate).toHaveBeenCalledWith('/');
  });
});
