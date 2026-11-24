import { Component, output } from '@angular/core';
import { MatIconButton } from '@angular/material/button';
import { MatIcon } from '@angular/material/icon';

/** Title of the members side sheet, inline on desktop or modal at intermediate widths. */
@Component({
  selector: 'app-members-header',
  imports: [MatIcon, MatIconButton],
  templateUrl: './members-header.html',
  styleUrl: './members-header.scss',
})
export class MembersHeader {
  public readonly dismiss = output();
}
