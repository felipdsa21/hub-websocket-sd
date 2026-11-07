import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NewActivity } from './new-activity';

describe('NewActivity', () => {
  let component: NewActivity;
  let fixture: ComponentFixture<NewActivity>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NewActivity],
    }).compileComponents();

    fixture = TestBed.createComponent(NewActivity);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
