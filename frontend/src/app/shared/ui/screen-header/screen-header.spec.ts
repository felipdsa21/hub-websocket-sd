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

  it('renders h1 by default and h2 when headingLevel is 2 (B5)', async () => {
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('h1')?.textContent?.trim()).toBe('Membros');
    expect(root.querySelector('h2')).toBeNull();

    fixture.componentRef.setInput('headingLevel', 2);
    await fixture.whenStable();
    expect(root.querySelector('h1')).toBeNull();
    expect(root.querySelector('h2')?.textContent?.trim()).toBe('Membros');
  });
});
