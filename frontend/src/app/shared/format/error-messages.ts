import { HubError } from '@/core/model/error';

/** Why a message was rejected, from the error's code alone (architecture, section 4.2). */
export function messageErrorReason(error: HubError): string {
  switch (error.code) {
    case 'invalidRequest':
      return 'requisição fora do formato';
    case 'forbidden':
      return 'você não participa desta conversa';
    case 'conflict':
      return 'outra alteração estava em andamento';
    case 'notRegistered':
      return 'conexão sem registro';
    default:
      return 'ação não permitida';
  }
}
