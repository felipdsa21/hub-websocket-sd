import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MembersHeader } from './members-header';

describe('MembersHeader', () => {
  let component: MembersHeader;
  let fixture: ComponentFixture<MembersHeader>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MembersHeader],
    }).compileComponents();

    fixture = TestBed.createComponent(MembersHeader);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
