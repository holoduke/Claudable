import type { chatLogEn } from '../en/chat-log';

/** FR chat-log strings — same keys as en/chat-log.ts. */
export const chatLogFr: Record<keyof typeof chatLogEn, string> = {
  'chat.log.ariaLabel': 'Messages du chat',
  'chat.log.copyTitle': 'Copier ce message',
  'chat.log.revertTitle': 'Restaurer le projet tel qu’il était après cette étape',
  'chat.log.revertBusyTitle': 'Attendez que l’agent ait terminé avant de restaurer',
  'chat.log.revertConfirm': 'Restaurer le projet tel qu’il était après cette étape ? Les modifications ultérieures seront annulées (vous pouvez relancer pour avancer à nouveau).',
  'chat.log.revertSuccess': 'Projet restauré à cette étape. L’aperçu est en cours d’actualisation.',
  'chat.log.revertFailed': 'Échec de la restauration.',
  'chat.log.revertFailedGeneric': 'Échec de la restauration. Le point de restauration n’est peut-être plus disponible.',
  'chat.log.revertFailedReason': 'Échec de la restauration : {reason}',
  'chat.log.loadOlder': 'Charger les messages plus anciens ({count} restants)',
  'chat.log.connectionError': 'Erreur de connexion',
  'chat.log.retrying': 'Nouvelle tentative automatique dans quelques secondes…',
  'chat.log.dismissError': 'Fermer l’erreur',
  'chat.log.usageLimitTitle': 'Limite d’utilisation de Claude atteinte',
  'chat.log.usageLimitBody': 'Le compte Claude utilisé pour vos exécutions a épuisé sa fenêtre de 5 heures.',
  'chat.log.usageLimitResets': 'Elle se réinitialise vers {time} (votre heure locale).',
  'chat.log.usageLimitHint': 'Attendez la réinitialisation ou associez ce projet à un autre compte dans Paramètres du projet → Claude.',
  'chat.log.detailTitle': 'Détails du journal',
  'chat.log.detailType': 'Type :',
  'chat.log.detailTime': 'Heure :',
  'chat.log.detailChanges': 'Modifications :',
  'chat.log.detailData': 'Données détaillées :',
};
