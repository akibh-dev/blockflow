import { DEFAULT_LIMITS, LIMIT_RANGES, resolveLimits } from '../../../core/limits';
import type { Limits } from '../../../core/limits';
import type { Settings } from '../../../core/bridgeProtocol';

const ROWS: { key: keyof Limits; label: string; help: string }[] = [
  { key: 'runHistory', label: 'Runs kept in the history', help: 'The Reports page and Runs tab show this many finished runs; older ones are dropped.' },
  { key: 'logEntries', label: 'Run log lines kept', help: 'The log at the bottom of the editor.' },
  { key: 'screenshots', label: 'Screenshots kept', help: 'Failure and step screenshots. Trace pictures and visual baselines have their own bounds.' },
  { key: 'maxStepsPerRun', label: 'Blocks per run (loop guard)', help: 'A run that goes through more blocks than this stops with an error, so a loop cannot run forever. Raise it for For Each over big lists.' },
];

/** Settings → Limits: four numbers saved into `bf:settings` when you leave the field; out-of-range values are clamped. */
export function LimitsSection({ settings, onSave }: { settings: Settings; onSave: (next: Settings) => void | Promise<void> }) {
  const limits = resolveLimits(settings);
  return (
    <>
      <h3>Limits</h3>
      <p className="bf-muted">Applies within a few seconds. Lower limits free browser storage; higher ones keep more history.</p>
      <table className="bf-table bf-limits">
        <tbody>
          {ROWS.map(({ key, label, help }) => (
            <tr key={key}>
              <td>
                <label htmlFor={`limit-${key}`}>{label}</label>
                <div className="bf-muted">{help}</div>
              </td>
              <td>
                <input
                  id={`limit-${key}`}
                  type="number"
                  // Remounted when the saved value changes, so a clamped value shows.
                  key={`${key}-${limits[key]}`}
                  defaultValue={limits[key]}
                  min={LIMIT_RANGES[key].min}
                  max={LIMIT_RANGES[key].max}
                  aria-label={label}
                  onBlur={(event) => {
                    const entered = event.target.value === '' ? DEFAULT_LIMITS[key] : Number(event.target.value);
                    const next = resolveLimits({ [key]: entered })[key];
                    event.target.value = String(next);
                    if (next !== limits[key]) void onSave({ ...settings, [key]: next });
                  }}
                />
                <div className="bf-muted">
                  {LIMIT_RANGES[key].min}–{LIMIT_RANGES[key].max}, default {DEFAULT_LIMITS[key]}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
