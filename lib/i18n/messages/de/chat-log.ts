import type { chatLogEn } from '../en/chat-log';

/** DE chat-log strings — same keys as en/chat-log.ts. */
export const chatLogDe: Record<keyof typeof chatLogEn, string> = {
  'chat.log.ariaLabel': 'Chatnachrichten',
  'chat.log.copyTitle': 'Diese Nachricht kopieren',
  'chat.log.revertTitle': 'Projekt auf den Stand nach diesem Schritt zurücksetzen',
  'chat.log.revertBusyTitle': 'Warte, bis der Agent fertig ist, bevor du zurücksetzt',
  'chat.log.revertConfirm': 'Projekt auf den Stand nach diesem Schritt zurücksetzen? Spätere Änderungen werden rückgängig gemacht (du kannst erneut ausführen, um wieder vorwärts zu gehen).',
  'chat.log.revertSuccess': 'Projekt auf diesen Schritt zurückgesetzt. Die Vorschau wird aktualisiert.',
  'chat.log.revertFailed': 'Zurücksetzen fehlgeschlagen.',
  'chat.log.revertFailedGeneric': 'Zurücksetzen fehlgeschlagen. Der Wiederherstellungspunkt ist möglicherweise nicht mehr verfügbar.',
  'chat.log.revertFailedReason': 'Zurücksetzen fehlgeschlagen: {reason}',
  'chat.log.loadOlder': 'Ältere Nachrichten laden (noch {count})',
  'chat.log.connectionError': 'Verbindungsfehler',
  'chat.log.retrying': 'Automatischer neuer Versuch in wenigen Sekunden…',
  'chat.log.dismissError': 'Fehlermeldung schließen',
  'chat.log.usageLimitTitle': 'Claude-Nutzungslimit erreicht',
  'chat.log.usageLimitBody': 'Das Claude-Konto für deine Ausführungen hat sein 5-Stunden-Fenster ausgeschöpft.',
  'chat.log.usageLimitResets': 'Es wird gegen {time} zurückgesetzt (deine Ortszeit).',
  'chat.log.usageLimitHint': 'Warte auf das Zurücksetzen oder stelle dieses Projekt unter Projekteinstellungen → Claude auf ein anderes Konto um.',
  'chat.log.detailTitle': 'Protokolldetails',
  'chat.log.detailType': 'Typ:',
  'chat.log.detailTime': 'Zeit:',
  'chat.log.detailChanges': 'Änderungen:',
  'chat.log.detailData': 'Detaillierte Daten:',
};
