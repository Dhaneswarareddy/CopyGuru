/**
 * Session settings are described declaratively. The create-session form is
 * rendered from this schema and the server validates against it, so adding a
 * setting means adding one entry here (plus whatever logic consumes it).
 */

export type SettingField =
  | {
      key: string;
      label: string;
      help?: string;
      type: 'select';
      options: readonly { value: string; label: string }[];
      default: string;
    }
  | { key: string; label: string; help?: string; type: 'toggle'; default: boolean };

export const SESSION_SETTINGS_SCHEMA = [
  {
    key: 'questionMode',
    label: 'Question mode',
    type: 'select',
    options: [{ value: 'OPEN_UPLOAD', label: 'Open upload' }],
    default: 'OPEN_UPLOAD',
    help: 'How questions enter the session. More modes (host-supplied, text…) can be added later.',
  },
  {
    key: 'previousAnswerVisibility',
    label: 'Previous answer visibility',
    type: 'select',
    options: [
      { value: 'BEFORE_ANSWER', label: 'Before answer' },
      { value: 'AFTER_ANSWER', label: 'After answer' },
      { value: 'NEVER', label: 'Never' },
    ],
    default: 'BEFORE_ANSWER',
    help: 'When participants may see what others answered: always, only once they have answered that question themselves, or never.',
  },
  { key: 'challengeMode', label: 'Challenge mode', type: 'toggle', default: true, help: 'Allow answers to be challenged.' },
  {
    key: 'anonymousAnswers',
    label: 'Anonymous answers',
    type: 'toggle',
    default: false,
    help: 'Hide who gave each answer from other participants (the host still sees names).',
  },
  {
    key: 'showConsensus',
    label: 'Allow participants to see consensus',
    type: 'toggle',
    default: true,
  },
  {
    key: 'allowParticipantChallenges',
    label: 'Allow participants to challenge',
    type: 'toggle',
    default: true,
    help: 'When off, only the host can open challenges.',
  },
  { key: 'chatEnabled', label: 'Chat', type: 'toggle', default: true, help: 'Let everyone in the session message the whole group.' },
  {
    key: 'privateChatEnabled',
    label: 'Private messages',
    type: 'toggle',
    default: true,
    help: 'Let participants message each other one-to-one. Nobody else, including the host, can read these.',
  },
  {
    key: 'approveAllJoins',
    label: 'Approve everyone who joins',
    type: 'toggle',
    default: false,
    help: 'Even people with the code wait until you admit them. Turn this on after removing someone so they cannot come straight back.',
  },
  {
    key: 'listedPublicly',
    label: 'Show on the home page',
    type: 'toggle',
    default: true,
    help: 'Visitors can see this session’s name and ask to join; you approve each request. People with the code can always join directly.',
  },
] as const satisfies readonly SettingField[];

export interface SessionSettings {
  questionMode: 'OPEN_UPLOAD';
  previousAnswerVisibility: 'BEFORE_ANSWER' | 'AFTER_ANSWER' | 'NEVER';
  challengeMode: boolean;
  anonymousAnswers: boolean;
  showConsensus: boolean;
  allowParticipantChallenges: boolean;
  chatEnabled: boolean;
  privateChatEnabled: boolean;
  listedPublicly: boolean;
  approveAllJoins: boolean;
}

export function defaultSettings(): SessionSettings {
  return Object.fromEntries(SESSION_SETTINGS_SCHEMA.map((f) => [f.key, f.default])) as unknown as SessionSettings;
}

/** Validates untrusted input against the schema; unknown keys are dropped and
 *  invalid values fall back to defaults. */
export function parseSettings(input: unknown): SessionSettings {
  const src = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of SESSION_SETTINGS_SCHEMA as readonly SettingField[]) {
    const v = src[field.key];
    if (field.type === 'toggle') out[field.key] = typeof v === 'boolean' ? v : field.default;
    else out[field.key] = field.options.some((o) => o.value === v) ? v : field.default;
  }
  return out as unknown as SessionSettings;
}
