import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
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
});
