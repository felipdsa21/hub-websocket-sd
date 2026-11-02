import { Component, input, output } from '@angular/core';
import { MatIcon } from '@angular/material/icon';
import { Avatar } from '@/shared/ui/avatar/avatar';
import { TimelineMessage } from '../timeline';

/** A chat message: others' on the left, the user's own on the right (design component Mensagem). */
@Component({
  selector: 'app-message-bubble',
  imports: [Avatar, MatIcon],
  templateUrl: './message-bubble.html',
  styleUrl: './message-bubble.scss',
  host: {
    '[class.own]': 'message().own',
    '[class.first]': 'message().first',
  },
})
export class MessageBubble {
  public readonly message = input.required<TimelineMessage>();
  public readonly discard = output<string>();
}
