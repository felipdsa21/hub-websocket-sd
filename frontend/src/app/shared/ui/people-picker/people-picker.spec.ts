import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideTestFixtures } from '@/core/fixtures/testing';
import { SessionStore } from '@/core/state/session-store';
import { PeoplePicker } from './people-picker';

describe('PeoplePicker', () => {
  let component: PeoplePicker;
  let fixture: ComponentFixture<PeoplePicker>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [PeoplePicker],
      providers: provideTestFixtures(),
    }).compileComponents();

    await TestBed.inject(SessionStore).enter('marina', 'Marina Alves');
    fixture = TestBed.createComponent(PeoplePicker);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });

  it('shows empty state with role=status when no person matches in fixture mode', async () => {
    const element = fixture.nativeElement as HTMLElement;
    const input = element.querySelector<HTMLInputElement>('input')!;
    input.value = 'ninguem-existe';
    input.dispatchEvent(new Event('input'));
    await fixture.whenStable();

    expect(element.querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'Nenhuma pessoa encontrada.',
    );
  });
});
