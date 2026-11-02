import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ScreenHeader } from './screen-header';

describe('ScreenHeader', () => {
  let component: ScreenHeader;
  let fixture: ComponentFixture<ScreenHeader>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ScreenHeader],
    }).compileComponents();

    fixture = TestBed.createComponent(ScreenHeader);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('title', 'Membros');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
