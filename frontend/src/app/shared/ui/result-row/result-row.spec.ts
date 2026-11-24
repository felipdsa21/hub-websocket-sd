import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ResultRow } from './result-row';

describe('ResultRow', () => {
  let component: ResultRow;
  let fixture: ComponentFixture<ResultRow>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ResultRow],
    }).compileComponents();

    fixture = TestBed.createComponent(ResultRow);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('title', 'Ana Lima');
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
