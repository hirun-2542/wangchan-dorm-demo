import { useEffect, useId, useRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { FamilyRole } from "./api";

export interface PageProps {
  view: string;
}

export interface PageHeaderProps {
  title: string;
  supporting?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, supporting, actions }: PageHeaderProps) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        <h1 className="text-2xl text-charcoal">{title}</h1>
        {supporting !== undefined && <p className="mt-1 text-sm text-steel">{supporting}</p>}
      </div>
      {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface CardProps {
  children: ReactNode;
  className?: string;
}

export function Card({ children, className }: CardProps) {
  return <section className={className === undefined ? "card" : `card ${className}`}>{children}</section>;
}

export interface CardHeaderProps {
  title: string;
  description?: string;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps) {
  return (
    <div className="mb-3 flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div className="min-w-0">
        <h2 className="text-[15px] text-charcoal">{title}</h2>
        {description !== undefined && <p className="mt-0.5 text-xs text-fog">{description}</p>}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export interface ToolbarProps {
  children: ReactNode;
  className?: string;
}

export function Toolbar({ children, className }: ToolbarProps) {
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className ?? ""}`}>{children}</div>
  );
}

export type BadgeTone = "paid" | "unpaid" | "vacant" | "review" | "unbilled" | "occupied" | "danger" | "neutral";

export interface BadgeProps {
  tone: BadgeTone;
  children: ReactNode;
  icon?: string;
}

export function Badge({ tone, children, icon }: BadgeProps) {
  return (
    <span className={`badge badge-${tone}`}>
      {icon === undefined ? (
        <span className="badge-dot" aria-hidden="true" />
      ) : (
        <span className="ms text-[14px]" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </span>
  );
}

export type StatusKey = "paid" | "unpaid" | "vacant" | "review";

const statusMeta: Record<StatusKey, { label: string; tone: BadgeTone; icon: string }> = {
  paid: { label: "จ่ายแล้ว", tone: "paid", icon: "check_circle" },
  unpaid: { label: "ยังไม่จ่าย", tone: "unpaid", icon: "schedule" },
  vacant: { label: "ว่าง", tone: "vacant", icon: "door_front" },
  review: { label: "รอตรวจ", tone: "review", icon: "fact_check" },
};

export interface StatusBadgeProps {
  status: StatusKey;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const meta = statusMeta[status];

  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger-soft";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "sm";
  icon?: string;
}

export function Button({ variant = "secondary", size = "md", icon, className, type = "button", children, ...rest }: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : "", className ?? ""]
    .filter((value) => value !== "")
    .join(" ");

  return (
    <button type={type} className={classes} {...rest}>
      {icon !== undefined && (
        <span className="ms text-[18px]" aria-hidden="true">
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: string;
  label: string;
}

export function IconButton({ icon, label, className, type = "button", children, ...rest }: IconButtonProps) {
  return (
    <button type={type} aria-label={label} className={className === undefined ? "icon-btn" : `icon-btn ${className}`} {...rest}>
      <span className="ms text-[20px]" aria-hidden="true">
        {icon}
      </span>
      {children}
    </button>
  );
}

export interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  type?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  inputMode?: "text" | "numeric" | "tel";
  disabled?: boolean;
  /** ปุ่มหรือไอคอนท้ายช่อง */
  trailing?: ReactNode;
}

export function Field({ label, value, onChange, id, type = "text", placeholder, helper, error, inputMode, disabled, trailing }: FieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const describedBy = error !== undefined ? `${fieldId}-error` : helper !== undefined ? `${fieldId}-help` : undefined;

  return (
    <div>
      <label className="field-label" htmlFor={fieldId}>
        {label}
      </label>
      <div className={trailing === undefined ? "" : "relative"}>
        <input
          id={fieldId}
          className={trailing === undefined ? "input" : "input pr-12"}
          type={type}
          value={value}
          placeholder={placeholder}
          inputMode={inputMode}
          disabled={disabled}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        {trailing}
      </div>
      {error !== undefined ? (
        // role="alert" ให้โปรแกรมอ่านหน้าจอประกาศข้อความผิดพลาดทันทีที่มันโผล่ (แบบเดียวกับ CredentialField)
        <p id={`${fieldId}-error`} className="mt-1.5 text-xs text-danger" role="alert">
          {error}
        </p>
      ) : helper !== undefined ? (
        <p id={`${fieldId}-help`} className="mt-1.5 text-xs text-fog">
          {helper}
        </p>
      ) : null}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  id?: string;
  helper?: string;
}

export function Select({ label, value, onChange, options, id, helper }: SelectProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;

  return (
    <div>
      <label className="field-label" htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        className="input"
        value={value}
        aria-describedby={helper !== undefined ? `${selectId}-help` : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {helper !== undefined && (
        <p id={`${selectId}-help`} className="mt-1.5 text-xs text-fog">
          {helper}
        </p>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  icon: string;
  title: string;
  description: string;
  action?: ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <span className="ms grid h-14 w-14 place-items-center rounded-2xl bg-paper-mist text-[28px] text-slate" aria-hidden="true">
        {icon}
      </span>
      <h2 className="text-lg text-charcoal">{title}</h2>
      <p className="max-w-md text-sm text-steel">{description}</p>
      {action !== undefined && <div className="mt-1">{action}</div>}
    </div>
  );
}

export interface SkeletonProps {
  className?: string;
}

export function Skeleton({ className }: SkeletonProps) {
  return <span className={className === undefined ? "skeleton block h-4 w-full" : `skeleton block ${className}`} aria-hidden="true" />;
}

export interface ToastProps {
  message: string;
  open: boolean;
}

export function Toast({ message, open }: ToastProps) {
  // The live region stays mounted (and hidden via CSS) so assistive tech knows it
  // before its contents change; only the message is swapped.
  return (
    <div className={open ? "toast" : "toast toast-off"} role="status" aria-live="polite" aria-atomic="true">
      {open && (
        <>
          <span className="ms text-[18px]" aria-hidden="true">
            info
          </span>
          {message}
        </>
      )}
    </div>
  );
}

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const node = ref.current;

    if (node === null) {
      return;
    }

    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
    >
      <div className="dialog-panel">
        <div className="flex items-start justify-between gap-4 border-b border-ash px-5 py-4">
          <h2 id={titleId} className="text-base text-charcoal">
            {title}
          </h2>
          <IconButton icon="close" label="ปิด" onClick={onClose} />
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer !== undefined && <div className="flex flex-wrap justify-end gap-2 border-t border-ash px-5 py-4">{footer}</div>}
      </div>
    </dialog>
  );
}

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, children, footer }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const node = ref.current;

    if (node === null) {
      return;
    }

    if (open && !node.open) {
      node.showModal();
    } else if (!open && node.open) {
      node.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          onClose();
        }
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4 border-b border-ash px-5 py-4">
          <h2 id={titleId} className="text-base text-charcoal">
            {title}
          </h2>
          <IconButton icon="close" label="ปิด" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer !== undefined && <div className="flex flex-wrap justify-end gap-2 border-t border-ash px-5 py-4">{footer}</div>}
      </div>
    </dialog>
  );
}

export interface DataTableColumn<T> {
  key: string;
  /** ข้อความหัวคอลัมน์ หรือคอนโทรลของคอลัมน์นั้น (เช่น ช่องเลือกทั้งคอลัมน์) */
  header: ReactNode;
  align?: "left" | "right";
  render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  emptyMessage?: string;
  minWidth?: number;
  wrapClassName?: string;
  /**
   * ให้แถวหัวตารางค้างบนจอเมื่อเลื่อนหน้า
   *
   * ต้องเป็น opt-in เพราะการทำให้ sticky ได้ต้องให้ตัว wrapper เองเป็น scroll
   * container (มี `overflow: auto` อยู่แล้วเพื่อรองรับตารางที่กว้างเกินจอ) —
   * ถ้าตารางไม่ต้องเลื่อนแนวนอน ผู้ใช้จะเห็นหัวค้างใต้แถบหัวหน้าแอปตามต้องการ
   * แต่ถ้าตารางกว้างเกินจอ หัวจะค้างเทียบกับ scrollport ของตาราง (ยังอ่านได้
   * ขณะเลื่อนดูคอลัมน์อื่น) ซึ่งเป็นพฤติกรรมที่ต้องการสำหรับตารางกว้างอยู่แล้ว
   */
  stickyHeader?: boolean;
}

export function DataTable<T>({ columns, rows, getRowKey, emptyMessage = "ไม่พบข้อมูล", minWidth = 720, wrapClassName, stickyHeader = false }: DataTableProps<T>) {
  if (rows.length === 0) {
    return <p className="px-3 py-8 text-center text-sm text-fog">{emptyMessage}</p>;
  }

  return (
    <div
      className={`table-wrap table-wrap-scroll ${stickyHeader ? "table-wrap-sticky" : ""} ${wrapClassName ?? ""}`.trim()}
    >
      <table className={stickyHeader ? "table table-sticky-head" : "table"} style={{ minWidth: `${minWidth}px` }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.align === "right" ? "num" : undefined}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={getRowKey(row)}>
              {columns.map((column) => (
                <td key={column.key} className={column.align === "right" ? "num" : undefined}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export interface StatBlockProps {
  label: string;
  value: string;
  supporting?: string;
  icon?: string;
  valueClassName?: string;
}

export function StatBlock({ label, value, supporting, icon, valueClassName }: StatBlockProps) {
  return (
    <div>
      <div className="flex items-center gap-2">
        {icon !== undefined && (
          <span className="ms text-[18px] text-steel" aria-hidden="true">
            {icon}
          </span>
        )}
        <p className="text-xs text-fog">{label}</p>
      </div>
      <p className={`num mt-1 text-lg leading-none ${valueClassName ?? "text-charcoal"}`}>{value}</p>
      {supporting !== undefined && <p className="mt-0.5 text-xs text-steel">{supporting}</p>}
    </div>
  );
}

export interface HeroMoneyProps {
  value: string;
  unit?: string;
  label?: string;
}

export function HeroMoney({ value, unit = " บาท", label }: HeroMoneyProps) {
  return (
    <div>
      {label !== undefined && <p className="text-[13px] text-fog">{label}</p>}
      <p className="num text-display font-medium leading-none tracking-[-0.02em] text-charcoal">
        {value}
        {unit}
      </p>
    </div>
  );
}

export interface MonogramProps {
  /** คลาสขนาด เช่น h-11 w-11 — ค่าเริ่มต้น h-9 w-9 */
  className?: string;
}

/** ตราของหอ — ไล่สีแบบ conic เฉพาะที่นี่ และมีอักษรย่ออยู่กลาง */
export function Monogram({ className }: MonogramProps) {
  return (
    <span
      className={`grid ${className ?? "h-9 w-9"} shrink-0 place-items-center rounded-xl bg-[image:var(--gradient-conic-spectrum)] p-[2px]`}
      aria-hidden="true"
    >
      <span className="grid h-full w-full place-items-center rounded-xl bg-canvas-white text-[13px] font-semibold text-charcoal">
        วจ
      </span>
    </span>
  );
}

/** สิทธิ์ในครอบครัว — โทนน้ำเงินสงวนให้เจ้าของเพราะเป็นการกระทำที่สูงกว่า */
export function RoleBadge({ role }: { role: FamilyRole }) {
  return role === "owner" ? (
    <Badge tone="unpaid" icon="shield_person">
      เจ้าของหอ
    </Badge>
  ) : (
    <Badge tone="neutral" icon="person">
      สมาชิก
    </Badge>
  );
}
