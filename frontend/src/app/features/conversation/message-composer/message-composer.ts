import { CdkTextareaAutosize } from '@angular/cdk/text-field';
import { Component, inject, input, signal } from '@angular/core';
import { FormField, form, validate } from '@angular/forms/signals';
import { MatIconButton } from '@angular/material/button';
import { MatError, MatFormField, MatSuffix } from '@angular/material/form-field';
import { MatIcon } from '@angular/material/icon';
import { MatInput } from '@angular/material/input';
import { MAX_REQUEST_BYTES, sendMessageRequestBytes } from '@/core/model/limits';
import { MessagesStore } from '@/core/state/messages-store';

/** The message field. Sending stays available offline: the message waits in the queue (RF12). */
@Component({
  selector: 'app-message-composer',
  imports: [
    CdkTextareaAutosize,
    FormField,
    MatError,
    MatFormField,
    MatIcon,
    MatIconButton,
    MatInput,
    MatSuffix,
  ],
  templateUrl: './message-composer.html',
  styleUrl: './message-composer.scss',
})
export class MessageComposer {
  private readonly messages = inject(MessagesStore);

  public readonly conversationId = input.required<string>();

  private readonly model = signal({ text: '' });
  protected readonly composer = form(this.model, (path) => {
    validate(path.text, ({ value }) =>
      sendMessageRequestBytes(this.conversationId(), value()) > MAX_REQUEST_BYTES
        ? {
            kind: 'tooLarge',
            message: 'A mensagem passa do limite de 32 KB. Divida o texto em partes menores.',
          }
        : undefined,
    );
  });

  protected canSend(): boolean {
    return this.model().text.trim() !== '' && this.composer().valid();
  }

  protected sendOnEnter(event: Event): void {
    // Enter sends; Shift+Enter breaks the line.
    if (!(event as KeyboardEvent).shiftKey) {
      this.send(event);
    }
  }

  protected send(event: Event): void {
    event.preventDefault();
    if (!this.canSend()) {
      return;
    }
    this.messages.send(this.conversationId(), this.model().text);
    this.model.set({ text: '' });
    this.composer().reset();
  }
}
