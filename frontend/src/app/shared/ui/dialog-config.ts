import { Binding } from '@angular/core';
import { MatDialogConfig } from '@angular/material/dialog';
import { WindowSize } from '@/core/layout/breakpoints';

/** Size of the dialogs with a form: full screen on phones, as in the design. */
export function formDialogConfig(
  windowSize: WindowSize,
  bindings: Binding[] = [],
): MatDialogConfig {
  return windowSize === 'compact'
    ? {
        bindings,
        width: '100vw',
        maxWidth: '100vw',
        height: '100%',
        maxHeight: '100%',
        panelClass: 'full-screen-dialog-panel',
      }
    : { bindings, width: '480px', maxWidth: '80vw' };
}
