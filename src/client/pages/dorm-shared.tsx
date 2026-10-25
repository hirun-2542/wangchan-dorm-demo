export function numericValue(value: string): number | null {
  if (value.trim() === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export interface ChoiceRowProps {
  name: string;
  checked: boolean;
  title: string;
  helper: string;
  onSelect: () => void;
}

export function ChoiceRow({ name, checked, title, helper, onSelect }: ChoiceRowProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
        checked ? "border-pebble bg-paper-mist" : "border-ash hover:bg-paper-mist"
      }`}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="mt-0.5 h-4 w-4 shrink-0 accent-midnight-ink"
      />
      <span className="min-w-0">
        <span className="block text-sm text-charcoal">{title}</span>
        <span className="block text-xs text-fog">{helper}</span>
      </span>
    </label>
  );
}
