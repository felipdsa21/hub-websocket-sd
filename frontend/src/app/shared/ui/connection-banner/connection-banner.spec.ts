import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ConnectionBanner } from './connection-banner';

describe('ConnectionBanner', () => {
  let component: ConnectionBanner;
  let fixture: ComponentFixture<ConnectionBanner>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ConnectionBanner],
    }).compileComponents();

    fixture = TestBed.createComponent(ConnectionBanner);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
