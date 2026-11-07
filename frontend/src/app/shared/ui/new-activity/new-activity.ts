import { Component, input } from '@angular/core';

/** Takes the place of the time in a list item with messages the user hasn't seen (RF10). */
@Component({
  selector: 'app-new-activity',
  templateUrl: './new-activity.html',
  styleUrl: './new-activity.scss',
})
export class NewActivity {
  public readonly time = input('');
}
