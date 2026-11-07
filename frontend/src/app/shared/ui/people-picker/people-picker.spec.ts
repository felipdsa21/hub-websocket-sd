import { ComponentFixture, TestBed } from '@angular/core/testing';
import { PeoplePicker } from './people-picker';

describe('PeoplePicker', () => {
  let component: PeoplePicker;
  let fixture: ComponentFixture<PeoplePicker>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PeoplePicker],
    }).compileComponents();

    fixture = TestBed.createComponent(PeoplePicker);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
