import type { chatLogEn } from '../en/chat-log';

/** NL chat-log strings — same keys as en/chat-log.ts. */
export const chatLogNl: Record<keyof typeof chatLogEn, string> = {
  'chat.log.ariaLabel': 'Chatberichten',
  'chat.log.copyTitle': 'Dit bericht kopiëren',
  'chat.log.revertTitle': 'Zet het project terug naar hoe het na deze stap was',
  'chat.log.revertBusyTitle': 'Wacht tot de agent klaar is voordat je terugzet',
  'chat.log.revertConfirm': 'Het project terugzetten naar hoe het na deze stap was? Latere wijzigingen worden teruggedraaid (je kunt opnieuw uitvoeren om weer vooruit te gaan).',
  'chat.log.revertSuccess': 'Project teruggezet naar deze stap. De preview wordt vernieuwd.',
  'chat.log.revertFailed': 'Terugzetten mislukt.',
  'chat.log.revertFailedGeneric': 'Terugzetten mislukt. Het herstelpunt is mogelijk niet meer beschikbaar.',
  'chat.log.revertFailedReason': 'Terugzetten mislukt: {reason}',
  'chat.log.loadOlder': 'Oudere berichten laden (nog {count})',
  'chat.log.connectionError': 'Verbindingsfout',
  'chat.log.retrying': 'Over een paar seconden wordt het automatisch opnieuw geprobeerd…',
  'chat.log.dismissError': 'Foutmelding sluiten',
  'chat.log.usageLimitTitle': 'Claude-gebruikslimiet bereikt',
  'chat.log.usageLimitBody': 'Het Claude-account dat voor je runs wordt gebruikt, heeft zijn venster van 5 uur opgebruikt.',
  'chat.log.usageLimitResets': 'Het wordt rond {time} gereset (jouw lokale tijd).',
  'chat.log.usageLimitHint': 'Wacht op de reset, of koppel dit project aan een ander account via Projectinstellingen → Claude.',
  'chat.log.detailTitle': 'Logdetails',
  'chat.log.detailType': 'Type:',
  'chat.log.detailTime': 'Tijd:',
  'chat.log.detailChanges': 'Wijzigingen:',
  'chat.log.detailData': 'Gedetailleerde gegevens:',
};
