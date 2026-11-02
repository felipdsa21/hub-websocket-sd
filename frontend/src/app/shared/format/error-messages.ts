import { HubError } from '@/core/model/error';
import { ActionFailure, AddMembersResult } from '@/core/state/group-actions';

const listFormat = new Intl.ListFormat('pt-BR', { type: 'conjunction' });

/**
 * Notice after adding people: who went in and why each failure happened (RF04, RF09). Null when
 * everyone was added, since the member notices in the conversation already show it.
 */
export function addMembersNotice(
  result: AddMembersResult,
  nameOf: (username: string) => string,
): string | null {
  if (result.failed.length === 0) {
    return null;
  }
  const parts: string[] = [];
  if (result.added.length > 0) {
    const names = listFormat.format(result.added.map(nameOf));
    parts.push(
      result.added.length === 1 ? `${names} foi adicionado.` : `${names} foram adicionados.`,
    );
  }
  for (const { username, reason } of result.failed) {
    parts.push(addMemberFailureText(nameOf(username), username, reason));
  }
  return parts.join(' ');
}

function addMemberFailureText(name: string, username: string, reason: ActionFailure): string {
  if (reason === 'noResponse') {
    return `Sem resposta. ${name} pode não ter sido adicionado.`;
  }
  switch (reason.code) {
    case 'invalidOperation':
      return `${name} já é membro do grupo.`;
    case 'notFound':
      return `Usuário não encontrado: ${username}`;
    default:
      return actionErrorText(reason);
  }
}

export function leaveFailureText(reason: ActionFailure): string {
  return reason === 'noResponse'
    ? 'Sem resposta. Você pode não ter saído do grupo.'
    : actionErrorText(reason);
}

function actionErrorText(error: HubError): string {
  switch (error.code) {
    case 'conflict':
      return 'Outra alteração estava em andamento. Tente de novo.';
    case 'forbidden':
      return 'Você não participa mais deste grupo.';
    default:
      return 'Não foi possível concluir a ação.';
  }
}

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
