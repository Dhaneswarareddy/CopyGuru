'use client';
import { SESSION_SETTINGS_SCHEMA, type SettingField } from '@/lib/domain/settings';
import { inputClass } from '@/components/ui/Badge';

interface Props {
  values: Record<string, unknown>;
  onChange(key: string, value: unknown): void;
  idPrefix?: string;
  disabled?: boolean;
}

/**
 * Renders every session setting from SESSION_SETTINGS_SCHEMA. Used when
 * creating a session and when the host edits settings later, so a new setting
 * added to the schema shows up in both places.
 */
export function SettingsFields({ values, onChange, idPrefix = 'setting', disabled }: Props) {
  return (
    <div className="space-y-3">
      {(SESSION_SETTINGS_SCHEMA as readonly SettingField[]).map((f) =>
        f.type === 'toggle' ? (
          <label key={f.key} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-accent"
              checked={!!values[f.key]}
              disabled={disabled}
              onChange={(e) => onChange(f.key, e.target.checked)}
            />
            <span>
              <span className="font-medium text-slate-800">{f.label}</span>
              {f.help && <span className="block text-xs text-slate-500">{f.help}</span>}
            </span>
          </label>
        ) : (
          <div key={f.key}>
            <label htmlFor={`${idPrefix}-${f.key}`} className="mb-1 block text-sm font-medium text-slate-800">
              {f.label}
            </label>
            <select
              id={`${idPrefix}-${f.key}`}
              className={inputClass}
              value={String(values[f.key])}
              disabled={disabled}
              onChange={(e) => onChange(f.key, e.target.value)}
            >
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
            {f.help && <p className="mt-1 text-xs text-slate-500">{f.help}</p>}
          </div>
        ),
      )}
    </div>
  );
}
