import { useId, useState, type Ref } from "react";

export interface CredentialFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * ตัวบอกตัวจัดการรหัสผ่านของเบราว์เซอร์ว่าช่องนี้คืออะไร
   * (`username` · `current-password` · `new-password` · `off` สำหรับค่าเชื่อมต่อ
   * อย่าง token ของ LINE ซึ่งไม่ใช่รหัสผ่านและไม่ควรถูกเสนอให้บันทึก)
   */
  autoComplete: "username" | "current-password" | "new-password" | "off";
  type?: "text" | "password";
  name?: string;
  placeholder?: string;
  helper?: string;
  error?: string;
  /** ให้ฟอร์มสั่งโฟกัสช่องที่ผิดเองได้ (React 19 ส่ง ref เป็น prop ได้ตรง ๆ) */
  inputRef?: Ref<HTMLInputElement>;
}

/**
 * ช่องกรอกชื่อผู้ใช้/รหัสผ่าน
 *
 * หน้าตาเหมือน `Field` ใน ui.tsx แต่รับ `autoComplete` และ `name` ที่ `Field` ไม่มี — ไม่มีสองค่านี้
 * Chrome เตือนและตัวจัดการรหัสผ่านเดาไม่ได้ว่าช่องไหนคือชื่อผู้ใช้ จึงเสนอบันทึก/กรอกไม่ถูกช่อง
 *
 * ต่างจาก `Field` อีกสามจุดซึ่งมาจากการ critique หน้า login:
 * - ตัวอักษรในช่อง 16px บนจอเล็ก: iOS Safari ซูมหน้าเองเมื่อโฟกัสช่องที่เล็กกว่า 16px
 *   ทุกครั้งที่ล็อกอินบน iPhone หน้าจะเลื่อนและต้องบีบกลับ
 * - ช่องรหัสผ่านมีปุ่มแสดง/ซ่อน (เป้ากด 44px) เพราะรหัสอย่างต่ำ 12 ตัวที่พิมพ์โดยมองไม่เห็น
 *   บนมือถือพลาดง่าย
 * - ข้อความผิดพลาดเป็น role="alert" ให้โปรแกรมอ่านหน้าจอประกาศทันทีที่ขึ้น
 *
 * แยกไฟล์เพราะตอนเพิ่มมี ui.tsx ที่ยังมีการแก้ค้างของอีกคน ถ้า `Field` ได้ความสามารถพวกนี้แล้ว
 * ให้ยุบไฟล์นี้กลับไปใช้ `Field`
 */
export function CredentialField({
  label,
  value,
  onChange,
  autoComplete,
  type = "text",
  name,
  placeholder,
  helper,
  error,
  inputRef,
}: CredentialFieldProps) {
  const fieldId = useId();
  const [shown, setShown] = useState(false);
  const revealable = type === "password";
  const describedBy = error !== undefined ? `${fieldId}-error` : helper !== undefined ? `${fieldId}-help` : undefined;

  return (
    <div>
      <label className="field-label" htmlFor={fieldId}>
        {label}
      </label>
      <div className={revealable ? "relative" : ""}>
        <input
          id={fieldId}
          ref={inputRef}
          className={`input text-[1rem] md:text-[0.875rem]${revealable ? " pr-12" : ""}`}
          type={revealable && shown ? "text" : type}
          name={name}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error !== undefined}
          aria-describedby={describedBy}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
        {revealable && (
          <button
            type="button"
            className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-steel transition-colors hover:text-charcoal"
            aria-label={shown ? "ซ่อนรหัสผ่าน" : "แสดงรหัสผ่าน"}
            aria-pressed={shown}
            onClick={() => {
              setShown((previous) => !previous);
            }}
          >
            <span className="ms text-[1.25rem]" aria-hidden="true">
              {shown ? "visibility_off" : "visibility"}
            </span>
          </button>
        )}
      </div>
      {error !== undefined ? (
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
