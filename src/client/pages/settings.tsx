import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import {
  ApiError,
  fetchDormCharges,
  fetchLineChannel,
  fetchSettings,
  regenerateOwnerCode,
  saveDormCharges,
  setLineWebhook,
  unlinkOwnerLine,
  updateCredentials,
  updateSettings,
  type CredentialName,
  type CredentialsUpdate,
  type DormChargeInput,
  type IntegrationCredentialStatus,
  type IntegrationCredentials,
  type LineChannelStatus,
  type PromptpayType,
  type Settings,
} from "../api";
import { useAuth } from "../auth";
import { CredentialField } from "../credential-field";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  IconButton,
  PageHeader,
  Skeleton,
  Toast,
} from "../ui";
import { ChoiceRow, numericValue } from "./dorm-shared";
import { bankLogoUrl, fetchBanks, type Bank } from "./banks";

const sectionList = [
  { id: "settings-dorm", label: "ข้อมูลหอ" },
  { id: "settings-rates", label: "ค่าน้ำ/ค่าไฟ" },
  { id: "settings-charges", label: "ค่าใช้จ่ายของหอ" },
  { id: "settings-payment", label: "ช่องทางรับเงิน" },
  { id: "settings-line", label: "LINE เจ้าของ" },
  { id: "settings-integrations", label: "การเชื่อมต่อ" },
] as const;

interface SectionProps {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}

interface ChargeDraft {
  key: number;
  id: string | null;
  name: string;
  amount: string;
}

let chargeKey = 0;

function nextChargeKey(): number {
  chargeKey += 1;
  return chargeKey;
}

function Section({ id, title, description, children }: SectionProps) {
  return (
    <div id={id} className="scroll-mt-20">
      <Card>
        <CardHeader title={title} description={description} />
        {children}
      </Card>
    </div>
  );
}

function IntegrationRow({
  name,
  description,
  configured,
}: {
  name: string;
  description: string;
  configured: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2.5">
      <div className="min-w-0">
        <span className="block text-sm text-charcoal">{name}</span>
        <span className="block text-xs text-fog">{description}</span>
      </div>
      <Badge
        tone={configured ? "paid" : "neutral"}
        icon={configured ? "check_circle" : "link_off"}
      >
        {configured ? "ตั้งค่าแล้ว" : "ยังไม่ตั้งค่า"}
      </Badge>
    </li>
  );
}

/**
 * ฟอร์มกรอกค่าเชื่อมต่อ (LINE OA · SlipOK)
 *
 * ค่าที่กรอกถูกเก็บในฐานข้อมูลของหอนี้และใช้แทนค่าเดิมที่ตั้งไว้ตอน deploy — ช่อง
 * ความลับไม่ถูกส่งค่าจริงกลับมา จึงว่างเสมอพร้อมข้อความใต้ช่องว่าตั้งไว้แล้วหรือยัง
 * และมีปุ่มล้างค่าเฉพาะรายการที่กรอกไว้ในหน้านี้ (ล้างแล้วกลับไปใช้ค่าเดิมของระบบ)
 */
function CredentialEditor({
  title,
  description,
  fields,
  credentials,
  draft,
  onChange,
  onClear,
  onSave,
  saving,
  error,
}: {
  title: string;
  description: string;
  fields: readonly CredentialFieldSpec[];
  credentials: IntegrationCredentials;
  draft: Record<CredentialName, string>;
  onChange: (name: CredentialName, value: string) => void;
  onClear: (field: CredentialFieldSpec) => void;
  onSave: () => void;
  saving: boolean;
  error: { field: CredentialName | null; message: string } | null;
}) {
  const pending = Object.keys(credentialDraftUpdates(fields, draft)).length > 0;

  return (
    <div className="mt-4 border-t border-ash pt-4">
      <p className="text-xs font-medium text-charcoal">{title}</p>
      <p className="mt-1 text-xs text-fog">{description}</p>

      <div className="mt-3 grid gap-3">
        {fields.map((field) => {
          const status = credentials[field.name];

          return (
            <div key={field.name}>
              <CredentialField
                label={field.label}
                type={field.secret ? "password" : "text"}
                autoComplete="off"
                name={field.name}
                value={draft[field.name]}
                placeholder={
                  status.source === "env" && status.value !== null
                    ? status.value
                    : field.placeholder
                }
                onChange={(value) => {
                  onChange(field.name, value);
                }}
                helper={credentialHelperText(status)}
                error={error !== null && error.field === field.name ? error.message : undefined}
              />
              {status.source === "settings" && (
                <div className="mt-1 text-right">
                  <button
                    type="button"
                    className="text-xs text-danger underline"
                    disabled={saving}
                    onClick={() => {
                      onClear(field);
                    }}
                  >
                    ล้างค่า {field.label}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {error !== null && error.field === null && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error.message}
        </p>
      )}

      <Button
        variant="primary"
        size="sm"
        icon="save"
        className="mt-3"
        disabled={saving || !pending}
        onClick={onSave}
      >
        {saving ? "กำลังบันทึก" : "บันทึก"}
      </Button>
    </div>
  );
}

/** ช่องกรอกค่าเชื่อมต่อที่เจ้าของกรอกเองได้ — ชื่อต้องตรงกับคีย์ที่ worker รับ (src/worker/lib/credentials.ts) */
interface CredentialFieldSpec {
  name: CredentialName;
  label: string;
  secret: boolean;
  placeholder: string;
}

const lineCredentialFields: readonly CredentialFieldSpec[] = [
  { name: "lineAccessToken", label: "Channel access token", secret: true, placeholder: "วางค่าจาก LINE Developers Console" },
  { name: "lineChannelSecret", label: "Channel secret", secret: true, placeholder: "วางค่าจาก LINE Developers Console" },
  { name: "liffId", label: "LIFF ID", secret: false, placeholder: "เช่น 1234567890-AbCdEfGh" },
];

const slipOkCredentialFields: readonly CredentialFieldSpec[] = [
  { name: "slipOkApiKey", label: "API key", secret: true, placeholder: "วางค่าจากหน้าเว็บ SlipOK" },
  { name: "slipOkBranchId", label: "Branch ID", secret: false, placeholder: "เช่น 10275" },
];

const credentialFieldNames: ReadonlySet<string> = new Set(
  [...lineCredentialFields, ...slipOkCredentialFields].map((field) => field.name),
);

/** ช่องที่ว่าง = "ไม่แก้" (การล้างค่าส่งสตริงว่างไปตั้งใจ ผ่านปุ่มล้างค่า) */
const emptyCredentialDraft: Record<CredentialName, string> = {
  lineAccessToken: "",
  lineChannelSecret: "",
  liffId: "",
  slipOkApiKey: "",
  slipOkBranchId: "",
};

/**
 * ค่าที่เติมในช่องกรอก
 *
 * ความลับไม่ถูกส่งกลับมาจากเซิร์ฟเวอร์ ช่องจึงว่างเสมอ (ข้อความใต้ช่องบอกว่าตั้งไว้แล้ว)
 * ส่วนค่าที่ไม่ใช่ความลับเติมกลับมาให้เห็นและแก้ต่อได้
 */
function credentialDraftFrom(credentials: IntegrationCredentials): Record<CredentialName, string> {
  return {
    ...emptyCredentialDraft,
    liffId: credentials.liffId.source === "settings" ? (credentials.liffId.value ?? "") : "",
    slipOkBranchId:
      credentials.slipOkBranchId.source === "settings" ? (credentials.slipOkBranchId.value ?? "") : "",
  };
}

function credentialDraftUpdates(
  fields: readonly CredentialFieldSpec[],
  draft: Record<CredentialName, string>,
): CredentialsUpdate {
  const updates: CredentialsUpdate = {};

  for (const field of fields) {
    const value = draft[field.name].trim();

    if (value !== "") {
      updates[field.name] = value;
    }
  }

  return updates;
}

/** บอกว่าค่าที่ใช้จริงตอนนี้มาจากไหน — ค่าที่กรอกในหน้านี้ชนะ wrangler secret เสมอ */
function credentialHelperText(status: IntegrationCredentialStatus): string {
  if (status.source === "settings") {
    return "ใช้ค่าที่กรอกไว้ในหน้านี้อยู่";
  }

  if (status.source === "env") {
    return "ยังไม่ได้กรอกในหน้านี้ — ใช้ค่าเดิมที่ตั้งไว้ตอน deploy (wrangler secret)";
  }

  return "ยังไม่ได้ตั้งค่าไว้ที่ไหนเลย";
}

const promptpayTypeLabels: Record<PromptpayType, string> = {
  phone: "เบอร์โทรศัพท์",
  "citizen-id": "เลขบัตรประชาชน / นิติบุคคล",
};

/** ความสว่างสัมพัทธ์ของสี — ใช้ตัดสินว่าพื้นสว่างพอจนโลโก้ขาวจะหายไปหรือไม่ */
function luminance(hex: string): number {
  const value = hex.replace("#", "");
  const channels = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return (
    0.2126 * (channels[0] ?? 0) +
    0.7152 * (channels[1] ?? 0) +
    0.0722 * (channels[2] ?? 0)
  );
}

/**
 * โลโก้ธนาคาร — ไฟล์ทุกตัวเป็นสีขาวบนพื้นโปร่งใส จึงต้องมีพื้นสีของธนาคารอยู่ข้างหลัง
 * ธนาคารสีอ่อนมาก (เช่น ttb #ecf0f1) ทำให้โลโก้ขาวจมหาย จึงใช้พื้น charcoal แทนและคาดแถบสีบาง ๆ ไว้ที่ขอบ
 */
function BankMark({
  bank,
  size = "md",
}: {
  bank: Bank | null;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "h-5 w-5" : "h-8 w-8";
  const pad = size === "sm" ? "p-0.5" : "p-1";

  if (bank === null) {
    return (
      <span
        className={`ms grid ${box} shrink-0 place-items-center rounded-md border border-ash text-[1.125rem] text-steel`}
        aria-hidden="true"
      >
        account_balance
      </span>
    );
  }

  // เกณฑ์ 0.75 คัดเฉพาะสีที่สว่างจนโลโก้ขาวหายจริง (ttb #ecf0f1 = 0.865)
  // สีอย่าง bay #fec43b (0.609) ยังอ่านออก จึงคงสีธนาคารไว้
  const faded = luminance(bank.color) > 0.75;

  return (
    <span
      className={`grid ${box} shrink-0 place-items-center rounded-md border border-ash/60 ${pad}`}
      style={{ backgroundColor: faded ? "#171717" : bank.color }}
    >
      <img
        src={bankLogoUrl(bank.id)}
        alt=""
        className="h-full w-full object-contain"
      />
    </span>
  );
}

function AccountNumberRow({
  bank,
  number,
}: {
  bank: Bank | null;
  number: string;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied && !copyFailed) {
      return;
    }

    const timer = window.setTimeout(() => {
      setCopied(false);
      setCopyFailed(false);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [copied, copyFailed]);

  const groups = number.replace(/(\d{3})(?=\d)/g, "$1 ");

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-3">
        <BankMark bank={bank} />
        <div className="min-w-0">
          <span className="block text-sm text-charcoal">
            {bank === null ? "บัญชีธนาคาร" : bank.thaiName}
          </span>
          <span className="num block text-xs text-fog">{groups}</span>
        </div>
      </div>
      <Button
        variant="secondary"
        size="sm"
        icon={copied ? "check" : copyFailed ? "error" : "content_copy"}
        onClick={() => {
          // บอกว่าคัดลอกแล้วได้ก็ต่อเมื่อเบราว์เซอร์คัดลอกให้จริง
          void navigator.clipboard
            .writeText(number)
            .then(() => {
              setCopyFailed(false);
              setCopied(true);
            })
            .catch(() => {
              setCopied(false);
              setCopyFailed(true);
            });
        }}
      >
        {copied ? "คัดลอกแล้ว" : copyFailed ? "คัดลอกไม่สำเร็จ" : "คัดลอกเลขบัญชี"}
      </Button>
    </div>
  );
}

/**
 * ตัวเลือกธนาคาร — ต้องวาดเองเพราะ <select> ของเบราว์เซอร์แสดงรูปใน <option> ไม่ได้
 * ใช้ .row-menu ที่มี elevation อยู่แล้ว และปิดเมื่อคลิกนอก/กด Escape/เลื่อนหน้า
 */
function BankSelect({
  banks,
  value,
  onChange,
  error,
}: {
  banks: Bank[];
  value: string;
  onChange: (id: string) => void;
  error?: string;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [listMaxHeight, setListMaxHeight] = useState<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = banks.find((bank) => bank.id === value) ?? null;

  const options: { id: string; bank: Bank | null }[] = [
    { id: "", bank: null },
    ...banks.map((bank) => ({ id: bank.id, bank })),
  ];

  const close = () => {
    setOpen(false);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;

      if (
        !(target instanceof Node) ||
        wrapRef.current?.contains(target) === true
      ) {
        return;
      }

      close();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close);
    window.addEventListener("resize", close);
    document.addEventListener("pointerdown", onPointerDown, true);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) {
      // preventScroll จำเป็น — ถ้าไม่ใส่ เบราว์เซอร์จะเลื่อนหน้าไปหารายการ ทำให้ตำแหน่งที่วัดเพี้ยน
      listRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  // จำกัดความสูงไม่ให้ล้นออกนอกจอหรือมุดใต้แถบบันทึกที่ลอยอยู่
  useEffect(() => {
    if (!open) {
      return;
    }

    const measure = () => {
      const trigger = wrapRef.current?.querySelector("button");

      if (trigger === null || trigger === undefined) {
        return;
      }

      const bar = document.querySelector(".save-bar");
      const limit =
        bar instanceof HTMLElement
          ? bar.getBoundingClientRect().top
          : window.innerHeight;
      const top = trigger.getBoundingClientRect().bottom + 6;

      setListMaxHeight(Math.max(160, Math.round(limit - top - 12)));
    };

    measure();
    window.addEventListener("resize", measure);

    return () => {
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  const commit = (next: string) => {
    onChange(next);
    close();
  };

  const onListKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;

    if (step !== 0) {
      event.preventDefault();
      const next = Math.min(
        Math.max(activeIndex + step, 0),
        options.length - 1,
      );
      setActiveIndex(next);
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const option = options[activeIndex];

      if (option !== undefined) {
        commit(option.id);
      }
    }
  };

  return (
    <div ref={wrapRef}>
      <label className="field-label" htmlFor={id}>
        ธนาคาร
      </label>
      <div className="relative">
        <button
          id={id}
          type="button"
          className={`input flex items-center gap-2.5 text-left${
            error === undefined ? "" : " border-danger"
          }`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-invalid={error !== undefined}
          aria-describedby={error === undefined ? `${id}-help` : `${id}-error`}
          onClick={() => {
            setActiveIndex(options.findIndex((option) => option.id === value));
            setOpen((current) => !current);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setActiveIndex(
                options.findIndex((option) => option.id === value),
              );
              setOpen(true);
            }
          }}
        >
          <BankMark bank={selected} size="sm" />
          <span
            className={`min-w-0 flex-1 truncate ${selected === null ? "text-fog" : "text-charcoal"}`}
          >
            {selected === null ? "ไม่ระบุธนาคาร" : selected.thaiName}
          </span>
          <span
            className="ms shrink-0 text-[1.25rem] text-steel"
            aria-hidden="true"
          >
            {open ? "expand_less" : "expand_more"}
          </span>
        </button>

        {open && (
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            tabIndex={-1}
            aria-label="เลือกธนาคาร"
            aria-activedescendant={
              activeIndex >= 0 && activeIndex < options.length
                ? `${listId}-option-${activeIndex}`
                : undefined
            }
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 overflow-y-auto rounded-xl border border-ash bg-canvas-white py-1 shadow-sm"
            style={
              listMaxHeight === null ? undefined : { maxHeight: listMaxHeight }
            }
            onKeyDown={onListKeyDown}
          >
            {options.map((option, index) => {
              const active = index === activeIndex;
              const isSelected = option.id === value;

              return (
                <button
                  key={option.id === "" ? "__none" : option.id}
                  id={`${listId}-option-${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`flex min-h-11 w-full items-center gap-2.5 px-2.5 text-left text-sm ${
                    active ? "bg-paper-mist" : ""
                  }`}
                  onPointerEnter={() => {
                    setActiveIndex(index);
                  }}
                  onClick={() => {
                    commit(option.id);
                  }}
                >
                  <BankMark bank={option.bank} size="sm" />
                  <span
                    className={`min-w-0 flex-1 truncate ${option.bank === null ? "text-fog" : ""}`}
                  >
                    {option.bank === null
                      ? "ไม่ระบุธนาคาร"
                      : option.bank.thaiName}
                  </span>
                  {isSelected && (
                    <span
                      className="ms shrink-0 text-[1.125rem] text-charcoal"
                      aria-hidden="true"
                    >
                      check
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {error === undefined ? (
        <p id={`${id}-help`} className="mt-1.5 text-xs text-fog">
          เลือกจากรายการเพื่อให้ได้โลโก้และสีของธนาคาร
        </p>
      ) : (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** ยอดตัวอย่างในตัวอย่าง QR — ยอดจริงมาจากบิลแต่ละใบ */
const sampleQrAmount = 1000;

/** กติกาเดียวกับ worker: เบอร์ 9–10 หลัก · เลขบัตร 13 หลัก */
function promptpayIdValid(id: string, type: PromptpayType): boolean {
  const digits = id.replace(/\D/g, "");

  return type === "phone"
    ? digits.length === 9 || digits.length === 10
    : digits.length === 13;
}

function QrPreview({
  promptpayId,
  payType,
}: {
  promptpayId: string;
  payType: PromptpayType;
}) {
  const [failed, setFailed] = useState(false);
  const id = promptpayId.trim();
  const ready = id !== "" && promptpayIdValid(id, payType);

  useEffect(() => {
    setFailed(false);
  }, [id, payType]);

  const url = ready
    ? `/qr/preview.png?${new URLSearchParams({
        id,
        type: payType,
        amount: String(sampleQrAmount),
      }).toString()}`
    : null;

  return (
    <div className="rounded-xl border border-ash p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm text-charcoal">QR พร้อมเพย์</span>
        {url === null || failed ? (
          <Badge tone="neutral" icon="link_off">
            ยังสร้างไม่ได้
          </Badge>
        ) : (
          <Badge tone="paid" icon="qr_code_2">
            ตัวอย่างสแกนได้
          </Badge>
        )}
      </div>

      {url === null || failed ? (
        <>
          <div className="mx-auto mt-3 grid h-40 w-40 place-items-center rounded-lg border border-dashed border-ash px-3 text-center">
            <span className="text-[0.6875rem] text-fog">
              {failed ? "สร้าง QR ไม่สำเร็จ" : "ยังกรอกพร้อมเพย์ไม่ครบ"}
            </span>
          </div>
          <p className="mt-3 text-center text-xs text-fog">
            {failed
              ? "ลองตรวจพร้อมเพย์ไอดีกับประเภทให้ตรงกันแล้วบันทึกอีกครั้ง"
              : payType === "phone"
                ? "กรอกเบอร์ที่ผูกพร้อมเพย์ 9–10 หลัก แล้วตัวอย่าง QR จะขึ้นที่นี่"
                : "กรอกเลขบัตรประชาชนหรือนิติบุคคล 13 หลัก แล้วตัวอย่าง QR จะขึ้นที่นี่"}
          </p>
        </>
      ) : (
        <>
          <img
            src={url}
            alt={`ตัวอย่าง QR พร้อมเพย์สำหรับยอด ${sampleQrAmount.toLocaleString("en-US")} บาท`}
            className="mx-auto mt-3 h-40 w-40"
            onError={() => {
              setFailed(true);
            }}
          />
          <p className="num mt-3 text-center text-sm text-charcoal">
            ตัวอย่างยอด {sampleQrAmount.toLocaleString("en-US")} บาท
          </p>
          <p className="mt-1 text-center text-xs text-fog">
            ยอดจริงระบบสร้างให้ตอนออกบิลแต่ละใบ
          </p>
          <p className="mt-1 text-center text-xs text-fog">
            บิลที่สร้างไปแล้วยังใช้พร้อมเพย์ที่บันทึกไว้ในบิลนั้น
          </p>
        </>
      )}
    </div>
  );
}

export function SettingsPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{
    message: string;
    field?: string;
  } | null>(null);
  const [dormName, setDormName] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerPhone, setOwnerPhone] = useState("");
  const [ownerLineId, setOwnerLineId] = useState("");
  const [waterRate, setWaterRate] = useState("");
  const [electricRate, setElectricRate] = useState("");
  const [payType, setPayType] = useState<PromptpayType>("phone");
  const [payId, setPayId] = useState("");
  const [payName, setPayName] = useState("");
  const [bankName, setBankName] = useState("");
  const [bankNumber, setBankNumber] = useState("");
  const [bankOwner, setBankOwner] = useState("");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [code, setCode] = useState("");
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);
  const [channel, setChannel] = useState<LineChannelStatus | null>(null);
  const [settingWebhook, setSettingWebhook] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // ตัวจริงที่กันกดรัว: state ใช้แค่ปิดปุ่ม เพราะอ่านค่าไม่ทันในคลิกเดียวกัน
  const regeneratingRef = useRef(false);
  const [confirmPayChange, setConfirmPayChange] = useState(false);
  const [activeSection, setActiveSection] = useState<string>(sectionList[0].id);
  const [toast, setToast] = useState<string | null>(null);
  const [chargeRows, setChargeRows] = useState<ChargeDraft[]>([]);
  const { user } = useAuth();
  const isOwner = user?.role === "owner";
  const [credentialDraft, setCredentialDraft] =
    useState<Record<CredentialName, string>>(emptyCredentialDraft);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [credentialError, setCredentialError] = useState<{
    field: CredentialName | null;
    message: string;
  } | null>(null);

  const applySettings = useCallback((data: Settings) => {
    setSettings(data);
    setDormName(data.dormName);
    setOwnerName(data.ownerName);
    setOwnerPhone(data.ownerPhone);
    setOwnerLineId(data.ownerLineId);
    setWaterRate(String(data.defaultWaterRate));
    setElectricRate(String(data.defaultElectricRate));
    setPayType(data.promptpayType === "citizen-id" ? "citizen-id" : "phone");
    setPayId(data.promptpayId);
    setPayName(data.promptpayName);
    setBankName(data.bankName);
    setBankNumber(data.bankAccountNumber);
    setBankOwner(data.bankAccountName);
    setCode(data.ownerLinkCode);
    setCredentialDraft(credentialDraftFrom(data.credentials));
    setCredentialError(null);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);

    try {
      const [data, charges, channelStatus] = await Promise.all([
        fetchSettings(),
        fetchDormCharges(),
        // สถานะช่อง LINE เป็นข้อมูลเสริม — ดึงไม่ได้ก็ไม่ทำให้หน้าล้ม
        fetchLineChannel().catch(() => null),
      ]);
      setChannel(channelStatus);
      applySettings(data);
      setChargeRows(
        charges.map((charge) => ({
          key: nextChargeKey(),
          id: charge.id,
          name: charge.name,
          amount: String(charge.amount),
        })),
      );
    } catch (error) {
      setLoadError(
        error instanceof ApiError ? error.message : "โหลดการตั้งค่าไม่สำเร็จ",
      );
    } finally {
      setLoading(false);
    }
  }, [applySettings]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;

    void fetchBanks().then((list) => {
      if (active) {
        setBanks(list);
      }
    });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (toast === null) {
      return;
    }

    const timer = window.setTimeout(() => {
      setToast(null);
    }, 3000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [toast]);

  const ready = !loading && loadError === null && settings !== null;

  useEffect(() => {
    if (!ready) {
      return;
    }

    const nodes = sectionList
      .map((item) => document.getElementById(item.id))
      .filter((node): node is HTMLElement => node !== null);

    if (nodes.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0];

        if (first !== undefined) {
          setActiveSection(first.target.id);
        }
      },
      { rootMargin: "-96px 0px -55% 0px", threshold: 0 },
    );

    nodes.forEach((node) => {
      observer.observe(node);
    });

    return () => {
      observer.disconnect();
    };
  }, [ready]);

  const waterValue = numericValue(waterRate);
  const electricValue = numericValue(electricRate);
  const ownerPhoneDigits = ownerPhone.replace(/[\s-]/g, "");
  const ownerPhoneValid =
    ownerPhoneDigits === "" || /^0\d{9}$/.test(ownerPhoneDigits);
  // LINE ID: "@" นำหน้าได้ ตัวที่เหลือ a–z 0–9 . _ - ยาว 4–30 (ตรงกับด่านฝั่ง server)
  // และห้ามเป็น id ของ OA หอเอง — ผู้เช่าคุยกับ OA นั้นอยู่แล้ว
  // OA ที่ใช้อยู่มาจาก settings.lineBot (ดึงจาก LINE) ไม่ใช่ค่าคงที่ในโค้ด
  const ownerLineIdBody = ownerLineId.trim().replace(/^@/, "").toLowerCase();
  const dormOaBody = (settings?.lineBot?.basicId ?? "").trim().replace(/^@/, "").toLowerCase();
  const ownerLineIdIsDormOa = dormOaBody !== "" && ownerLineIdBody === dormOaBody;
  const ownerLineIdValid =
    ownerLineIdBody === "" ||
    (!ownerLineIdIsDormOa && /^[A-Za-z0-9._-]{4,30}$/.test(ownerLineIdBody));
  const bankDigits = bankNumber.replace(/\D/g, "");
  const bankNumberValid =
    bankDigits === "" || (bankDigits.length >= 10 && bankDigits.length <= 15);
  // บัญชีธนาคารนับว่าใช้ได้เฉพาะเมื่อเลือกธนาคารและกรอกเลขบัญชีครบคู่
  // เลขบัญชีอย่างเดียวโดยไม่รู้ธนาคารทำให้ผู้เช่าโอนเงินไม่ได้จริง
  const hasBankPayout = bankName.trim() !== "" && bankDigits !== "";
  const hasPayoutDestination = payId.trim() !== "" || hasBankPayout;
  const chargeRowsInvalid = chargeRows.some((row) => {
    const amount = numericValue(row.amount);
    return (
      row.name.trim() === "" ||
      amount === null ||
      !Number.isInteger(amount) ||
      amount < 0
    );
  });
  const canSave =
    dormName.trim() !== "" &&
    hasPayoutDestination &&
    bankNumberValid &&
    ownerPhoneValid &&
    ownerLineIdValid &&
    waterValue !== null &&
    waterValue > 0 &&
    electricValue !== null &&
    electricValue > 0 &&
    !chargeRowsInvalid &&
    !saving;

  const fieldError = (name: string): string | undefined =>
    saveError !== null && saveError.field === name
      ? saveError.message
      : undefined;

  const payChanges: { label: string; from: string; to: string }[] = [];

  if (settings !== null) {
    if (payType !== settings.promptpayType) {
      payChanges.push({
        label: "ประเภทพร้อมเพย์",
        from: promptpayTypeLabels[settings.promptpayType],
        to: promptpayTypeLabels[payType],
      });
    }

    if (payId.trim() !== settings.promptpayId) {
      payChanges.push({
        label: "พร้อมเพย์ไอดี",
        from: settings.promptpayId,
        to: payId.trim(),
      });
    }

    if (bankDigits !== settings.bankAccountNumber.replace(/\D/g, "")) {
      payChanges.push({
        label: "เลขบัญชีธนาคาร",
        from:
          settings.bankAccountNumber === ""
            ? "ยังไม่ได้กรอก"
            : settings.bankAccountNumber,
        to: bankDigits === "" ? "ยังไม่ได้กรอก" : bankDigits,
      });
    }
  }

  const payChanged = payChanges.length > 0;

  const selectedBank = banks.find((bank) => bank.id === bankName) ?? null;

  const goTo = (id: string) => {
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveSection(id);
  };

  const appendChargeRow = () => {
    setChargeRows((rows) => [
      ...rows,
      { key: nextChargeKey(), id: null, name: "", amount: "" },
    ]);
  };

  const removeChargeRow = (key: number) => {
    setChargeRows((rows) => rows.filter((row) => row.key !== key));
  };

  const editChargeRow = (
    key: number,
    patch: Partial<Pick<ChargeDraft, "name" | "amount">>,
  ) => {
    setChargeRows((rows) =>
      rows.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    );
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);

    try {
      const updated = await updateSettings({
        dormName: dormName.trim(),
        ownerName: ownerName.trim(),
        ownerPhone: ownerPhone.trim(),
        ownerLineId: ownerLineId.trim(),
        defaultWaterRate: waterValue ?? 0,
        defaultElectricRate: electricValue ?? 0,
        promptpayType: payType,
        promptpayId: payId.trim(),
        promptpayName: payName.trim(),
        bankName: bankName.trim(),
        bankAccountNumber: bankNumber,
        bankAccountName: bankOwner.trim(),
      });
      applySettings(updated);

      const inputs: DormChargeInput[] = chargeRows.map((row) => {
        const amount = numericValue(row.amount) ?? 0;
        return row.id === null
          ? { name: row.name.trim(), amount }
          : { id: row.id, name: row.name.trim(), amount };
      });
      const savedCharges = await saveDormCharges(inputs);
      setChargeRows(
        savedCharges.map((charge) => ({
          key: nextChargeKey(),
          id: charge.id,
          name: charge.name,
          amount: String(charge.amount),
        })),
      );

      setToast("บันทึกการตั้งค่าเรียบร้อย");
    } catch (error) {
      if (error instanceof ApiError && error.field !== undefined) {
        setSaveError({ message: error.message, field: error.field });
      } else {
        setSaveError(null);
        setToast(
          error instanceof ApiError
            ? error.message
            : "บันทึกการตั้งค่าไม่สำเร็จ",
        );
      }
    } finally {
      setSaving(false);
    }
  };

  const unlink = async () => {
    setUnlinking(true);

    try {
      await unlinkOwnerLine();
      const refreshed = await fetchSettings();
      applySettings(refreshed);
      setConfirmUnlink(false);
      setToast("เลิกเชื่อม LINE แล้ว — รหัสเดิมถูกยกเลิก ต้องออกรหัสใหม่ถ้าจะเชื่อมอีก");
    } catch (error) {
      setConfirmUnlink(false);
      setToast(
        error instanceof ApiError ? error.message : "เลิกเชื่อม LINE ไม่สำเร็จ",
      );
    } finally {
      setUnlinking(false);
    }
  };

  const setWebhook = async () => {
    setSettingWebhook(true);

    try {
      const endpoint = await setLineWebhook();
      setChannel(await fetchLineChannel().catch(() => null));
      setToast(`ตั้ง webhook เป็น ${endpoint} แล้ว`);
    } catch (error) {
      setToast(
        error instanceof ApiError ? error.message : "ตั้ง webhook ไม่สำเร็จ",
      );
    } finally {
      setSettingWebhook(false);
    }
  };

  /**
   * บันทึกค่าเชื่อมต่อ — ส่งเฉพาะช่องที่กรอก ค่าว่าง = ล้างค่านั้น
   *
   * หลังบันทึกดึงการตั้งค่ากลับมาทั้งชุด เพราะทั้งสถานะ "ตั้งค่าแล้ว" ของการ์ดรวมและ
   * ชื่อ OA ที่แสดงคำนวณจากค่าที่เพิ่งบันทึก (worker ล้าง cache ข้อมูล OA ให้แล้ว)
   */
  const submitCredentials = async (updates: CredentialsUpdate, message: string) => {
    setSavingCredentials(true);
    setCredentialError(null);

    try {
      await updateCredentials(updates);
      const [data, channelStatus] = await Promise.all([
        fetchSettings(),
        fetchLineChannel().catch(() => null),
      ]);
      applySettings(data);
      setChannel(channelStatus);
      setToast(message);
    } catch (error) {
      if (error instanceof ApiError) {
        // ข้อผิดพลาดรายช่องแสดงใต้ช่องนั้น ไม่ต้องซ้ำด้วย toast
        const field = error.field ?? "";

        if (credentialFieldNames.has(field)) {
          setCredentialError({ field: field as CredentialName, message: error.message });
        } else {
          setCredentialError(null);
          setToast(error.message);
        }
      } else {
        setCredentialError(null);
        setToast("บันทึกค่าเชื่อมต่อไม่สำเร็จ");
      }
    } finally {
      setSavingCredentials(false);
    }
  };

  const changeCredential = (name: CredentialName, value: string) => {
    setCredentialDraft((previous) => ({ ...previous, [name]: value }));
  };

  const clearCredential = (field: CredentialFieldSpec) => {
    void submitCredentials(
      { [field.name]: "" },
      `ล้างค่า ${field.label} แล้ว — กลับไปใช้ค่าเดิมของระบบ`,
    );
  };

  const saveCredentialFields = (fields: readonly CredentialFieldSpec[], message: string) => {
    void submitCredentials(credentialDraftUpdates(fields, credentialDraft), message);
  };

  const regenCode = async () => {
    // ออกซ้ำสองครั้งจะได้รหัสสองใบและใบแรกใช้ไม่ได้ทันที ต้องกันกดรัว
    // ต้องกันด้วย ref เพราะ state ยังไม่ทันอัปเดตภายในคีย์เดียวกัน
    if (regeneratingRef.current) {
      return;
    }

    regeneratingRef.current = true;
    setRegenerating(true);

    try {
      const next = await regenerateOwnerCode();
      setCode(next);
      setSettings((current) =>
        current === null ? current : { ...current, ownerLinkCode: next },
      );
      setConfirmRegen(false);
      setToast(`ออกรหัสเชื่อมต่อใหม่ ${next} แล้ว`);
    } catch (error) {
      setConfirmRegen(false);
      setToast(
        error instanceof ApiError
          ? error.message
          : "ออกรหัสเชื่อมต่อใหม่ไม่สำเร็จ",
      );
    } finally {
      regeneratingRef.current = false;
      setRegenerating(false);
    }
  };

  const ownerConnected = settings?.ownerLineConnected ?? false;
  const ownerBot = settings?.lineBot ?? null;

  /**
   * ใครกำลังเชื่อมอยู่ — `ownerLineDisplayName` เป็น null เมื่อยังไม่ผูก และ ""
   * เมื่อผูกแล้วแต่ยังไม่รู้ชื่อ (เช่น profile เรียกไม่ได้) ซึ่งเป็นคนละความหมาย
   * กัน จึงต้องแยกคำตอบ ไม่ใช่แสดง "ไม่ทราบ" เหมือนกันทั้งคู่
   */
  const ownerNameWho =
    settings?.ownerLineDisplayName === null || settings?.ownerLineDisplayName === undefined
      ? ""
      : settings.ownerLineDisplayName === ""
        ? "เชื่อมด้วยบัญชี LINE ที่ยังอ่านชื่อไม่ได้"
        : `เชื่อมด้วยบัญชี ${settings.ownerLineDisplayName}`;

  return (
    <div className="pb-24">
      <PageHeader
        title="ตั้งค่า"
        supporting="แก้ค่าตั้งต้นของหอโดยไม่กระทบบิลที่สร้างไปแล้ว"
      />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[200px_minmax(0,1fr)]">
        <nav
          aria-label="หัวข้อตั้งค่า"
          className="min-w-0 lg:sticky lg:top-20 lg:self-start"
        >
          <ul className="-mx-1 flex gap-1 overflow-x-auto pb-1 pl-1 pr-6 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] lg:mx-0 lg:flex-col lg:overflow-visible lg:pb-0 lg:pl-0 lg:pr-0 lg:[mask-image:none]">
            {sectionList.map((item) => {
              const active = activeSection === item.id;

              return (
                <li key={item.id}>
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    onClick={() => {
                      goTo(item.id);
                    }}
                    className={`flex min-h-11 w-auto items-center whitespace-nowrap rounded-lg px-3 text-left text-sm transition-colors lg:w-full ${
                      active
                        ? "bg-status-unpaid-bg font-medium text-deep-sapphire"
                        : "text-steel hover:bg-paper-mist"
                    }`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="grid gap-4 [&>*]:min-w-0">
          {/* min-w-0 ให้การ์ดยอมแคบกว่า min-content ของตัวเอง (token ยาวในส่วน "การเชื่อมต่อ"
              เคยดันแถวจนล้นจอ 390px) — ข้อความที่ยาวเกินจะตัด/ขึ้นบรรทัดในกล่องแทน */}
          {loadError !== null ? (
            <Card>
              <EmptyState
                icon="cloud_off"
                title="โหลดการตั้งค่าไม่สำเร็จ"
                description={loadError}
                action={
                  <Button
                    variant="secondary"
                    icon="refresh"
                    onClick={() => {
                      void load();
                    }}
                  >
                    ลองใหม่
                  </Button>
                }
              />
            </Card>
          ) : settings === null ? (
            <Card>
              <div className="grid gap-4" aria-busy="true">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-24 w-full" />
                <Skeleton className="h-10 w-2/3" />
              </div>
            </Card>
          ) : (
            <>
              <Section
                id="settings-dorm"
                title="ข้อมูลหอ"
                description="แสดงบนใบแจ้งหนี้และข้อความที่ส่งถึงผู้เช่า"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="ชื่อหอ"
                    value={dormName}
                    onChange={setDormName}
                    error={
                      fieldError("dormName") ??
                      (dormName.trim() === "" ? "กรอกชื่อหอ" : undefined)
                    }
                  />
                  <Field
                    label="ชื่อเจ้าของ"
                    value={ownerName}
                    onChange={setOwnerName}
                    error={fieldError("ownerName")}
                  />
                  <Field
                    label="เบอร์โทรเจ้าของ"
                    value={ownerPhone}
                    onChange={setOwnerPhone}
                    inputMode="tel"
                    helper="ใช้ตอบกลับผู้เช่าที่พิมพ์ ติดต่อเจ้าของ"
                    error={
                      fieldError("ownerPhone") ??
                      (ownerPhoneValid
                        ? undefined
                        : "กรอกเบอร์ 10 หลัก เริ่มด้วย 0")
                    }
                  />
                </div>
              </Section>

              <Section
                id="settings-rates"
                title="ค่าน้ำ/ค่าไฟ"
                description="อัตราตั้งต้นที่ใช้กับห้องที่ยังไม่กำหนดอัตราเอง"
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="ค่าน้ำตั้งต้น (บาท/หน่วย)"
                    value={waterRate}
                    onChange={setWaterRate}
                    inputMode="numeric"
                    helper={`ปัจจุบัน ${settings.defaultWaterRate} บาท/หน่วย`}
                    error={
                      fieldError("defaultWaterRate") ??
                      (waterValue === null || waterValue <= 0
                        ? "กรอกอัตราที่มากกว่า 0"
                        : undefined)
                    }
                  />
                  <Field
                    label="ค่าไฟตั้งต้น (บาท/หน่วย)"
                    value={electricRate}
                    onChange={setElectricRate}
                    inputMode="numeric"
                    helper={`ปัจจุบัน ${settings.defaultElectricRate} บาท/หน่วย`}
                    error={
                      fieldError("defaultElectricRate") ??
                      (electricValue === null || electricValue <= 0
                        ? "กรอกอัตราที่มากกว่า 0"
                        : undefined)
                    }
                  />
                </div>
                <div className="panel-muted mt-4">
                  <p className="text-sm text-charcoal">
                    บิลที่สร้างไปแล้วจะไม่เปลี่ยนตามค่านี้
                  </p>
                  <p className="mt-1 text-xs text-steel">
                    ทุกบิลจะเก็บอัตราน้ำไฟที่ใช้ตอนออกบิลไว้เป็นข้อมูลของบิลนั้น
                    และใช้ค่าที่บันทึกไว้ตลอดไป
                  </p>
                </div>
              </Section>

              <Section
                id="settings-charges"
                title="ค่าใช้จ่ายของหอ"
                description="เก็บกับทุกห้องโดยอัตโนมัติ ปิดเป็นรายห้องได้ที่หน้าห้องพัก"
              >
                {chargeRows.length > 0 && (
                  <div className="flex items-end gap-2" aria-hidden="true">
                    <span className="field-label min-w-0 flex-1">
                      ชื่อรายการ
                    </span>
                    <span className="field-label w-24 shrink-0 text-right">
                      จำนวนเงิน
                    </span>
                    <span className="w-11 shrink-0 md:w-[38px]" />
                  </div>
                )}

                <div className="grid gap-2">
                  {chargeRows.map((row) => {
                    const amount = numericValue(row.amount);
                    const nameInvalid = row.name.trim() === "";
                    const amountInvalid =
                      amount === null ||
                      !Number.isInteger(amount) ||
                      amount < 0;

                    return (
                      <div key={row.key} className="flex items-end gap-2">
                        <div className="min-w-0 flex-1">
                          <input
                            type="text"
                            aria-label={`ชื่อรายการ ${row.key}`}
                            placeholder="เช่น ค่าบริการ"
                            className={`input-inline w-full text-left${nameInvalid ? " border-danger" : ""}`}
                            value={row.name}
                            aria-invalid={nameInvalid}
                            aria-describedby={chargeRowsInvalid ? "settings-charges-error" : undefined}
                            onChange={(event) => {
                              editChargeRow(row.key, {
                                name: event.target.value,
                              });
                            }}
                          />
                        </div>
                        <div className="w-24 shrink-0">
                          <input
                            type="text"
                            inputMode="numeric"
                            aria-label={`จำนวนเงิน ${row.key}`}
                            className={`input-inline num w-full${amountInvalid ? " border-danger" : ""}`}
                            value={row.amount}
                            aria-invalid={amountInvalid}
                            aria-describedby={chargeRowsInvalid ? "settings-charges-error" : undefined}
                            onChange={(event) => {
                              editChargeRow(row.key, {
                                amount: event.target.value,
                              });
                            }}
                          />
                        </div>
                        <IconButton
                          icon="delete"
                          label="ลบรายการนี้"
                          onClick={() => {
                            removeChargeRow(row.key);
                          }}
                        />
                      </div>
                    );
                  })}
                </div>

                <Button
                  variant="ghost"
                  size="sm"
                  icon="add"
                  className="mt-2"
                  onClick={appendChargeRow}
                >
                  เพิ่มรายการ
                </Button>

                {chargeRowsInvalid && (
                  <p id="settings-charges-error" className="mt-1 text-xs text-danger">
                    ค่าใช้จ่ายของหอต้องมีชื่อและจำนวนเงินเป็นจำนวนเต็มไม่ติดลบ
                  </p>
                )}
                {fieldError("charges") !== undefined && (
                  <p className="text-xs text-danger">{fieldError("charges")}</p>
                )}

                <div className="panel-muted mt-4">
                  <p className="text-sm text-charcoal">
                    บิลที่สร้างไปแล้วจะไม่เปลี่ยนตามค่านี้
                  </p>
                  <p className="mt-1 text-xs text-steel">
                    ทุกบิลเก็บรายการและยอดที่ใช้ตอนออกบิลไว้ในตัวบิลนั้น
                    แก้ที่นี่มีผลกับบิลที่ออกใหม่เท่านั้น
                  </p>
                </div>
              </Section>

              <Section
                id="settings-payment"
                title="ช่องทางรับเงิน"
                description="ผู้เช่าเห็นข้อมูลนี้บนใบแจ้งหนี้และการ์ด LINE · มีพร้อมเพย์หรือเลขบัญชีอย่างน้อยหนึ่งอย่าง"
              >
                <p className="field-label">พร้อมเพย์</p>
                <p className="-mt-3 mb-2 text-xs text-fog">
                  ใช้สร้าง QR ให้ผู้เช่าสแกนจ่ายยอดตรงตอนออกบิล
                </p>
                <fieldset className="grid gap-2">
                  <legend className="sr-only">ประเภทพร้อมเพย์</legend>
                  <ChoiceRow
                    name="promptpay-type"
                    checked={payType === "phone"}
                    title={promptpayTypeLabels.phone}
                    helper="ใช้เบอร์ที่ผูกพร้อมเพย์ไว้ เช่น 081-234-5678"
                    onSelect={() => {
                      setPayType("phone");
                    }}
                  />
                  <ChoiceRow
                    name="promptpay-type"
                    checked={payType === "citizen-id"}
                    title={promptpayTypeLabels["citizen-id"]}
                    helper="ใช้เลข 13 หลักที่ลงทะเบียนพร้อมเพย์"
                    onSelect={() => {
                      setPayType("citizen-id");
                    }}
                  />
                </fieldset>

                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <Field
                    label="PromptPay ID"
                    value={payId}
                    onChange={setPayId}
                    helper={
                      payType === "phone"
                        ? "เบอร์โทรศัพท์ที่ผูกพร้อมเพย์"
                        : "เลขบัตรประชาชนหรือเลขทะเบียนนิติบุคคล 13 หลัก"
                    }
                    error={fieldError("promptpayId")}
                  />
                  <Field
                    label="ชื่อบัญชีพร้อมเพย์"
                    value={payName}
                    onChange={setPayName}
                    error={fieldError("promptpayName")}
                  />
                </div>

                <div className="mt-4">
                  <QrPreview promptpayId={payId} payType={payType} />
                </div>

                <div className="mt-6 border-t border-ash pt-5">
                  <p className="field-label">บัญชีธนาคาร</p>
                  <p className="-mt-3 mb-2 text-xs text-fog">
                    ใช้เมื่อไม่มีพร้อมเพย์ ·
                    ระบบจะแสดงเลขบัญชีและปุ่มคัดลอกให้ผู้เช่าแทน QR
                  </p>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <BankSelect
                      banks={banks}
                      value={bankName}
                      onChange={setBankName}
                      error={fieldError("bankName")}
                    />
                    <Field
                      label="เลขบัญชี"
                      value={bankNumber}
                      onChange={setBankNumber}
                      inputMode="numeric"
                      placeholder="xxx-x-xxxxx-x"
                      helper="ตัวเลข 10–15 หลัก ใส่ขีดหรือเว้นวรรคก็ได้"
                      error={
                        fieldError("bankAccountNumber") ??
                        (bankNumberValid
                          ? undefined
                          : "เลขบัญชีต้องเป็นตัวเลข 10–15 หลัก")
                      }
                    />
                    <Field
                      label="ชื่อเจ้าของบัญชี"
                      value={bankOwner}
                      onChange={setBankOwner}
                      error={fieldError("bankAccountName")}
                    />
                  </div>

                  {bankDigits === "" ? (
                    <p className="mt-3 text-xs text-fog">
                      ยังไม่ได้กรอกเลขบัญชี
                    </p>
                  ) : bankName.trim() === "" ? (
                    <p className="mt-3 text-xs text-danger">
                      กรอกเลขบัญชีแล้วแต่ยังไม่ได้เลือกธนาคาร ผู้เช่าโอนเงินไม่ได้ถ้าไม่รู้ธนาคาร
                    </p>
                  ) : (
                    <AccountNumberRow bank={selectedBank} number={bankDigits} />
                  )}
                </div>

                {!hasPayoutDestination && (
                  <p className="mt-4 text-xs text-danger">
                    กรอกพร้อมเพย์ หรือเลือกธนาคารพร้อมเลขบัญชีคู่กัน อย่างน้อยหนึ่งช่องทาง
                  </p>
                )}
              </Section>

              <Section
                id="settings-line"
                title="LINE เจ้าของ"
                description="สองเรื่องนี้ต่างกัน: บัญชีที่รับแจ้งเตือนจากระบบ กับ LINE ส่วนตัวที่ผู้เช่าใช้ติดต่อคุณ"
              >
                <div className="grid gap-4">
                  <Field
                    label="LINE ส่วนตัวของเจ้าของ"
                    value={ownerLineId}
                    onChange={setOwnerLineId}
                    placeholder="@somchai"
                    helper="ผู้เช่าจะได้ค่านี้ในข้อความ ติดต่อเจ้าของ พร้อมปุ่มคัดลอก — ใช้ช่องนี้ช่องเดียว ไม่ใช่ OA ของหอ"
                    error={
                      fieldError("ownerLineId") ??
                      (ownerLineIdIsDormOa
                        ? "นี่คือ LINE ของ OA หอ ไม่ใช่ LINE ส่วนตัวของคุณ"
                        : ownerLineIdValid
                          ? undefined
                          : "ใช้ตัวอักษรอังกฤษ ตัวเลข จุด ขีด หรือ _ ยาว 4–30 ตัว")
                    }
                  />
                </div>
                {/* คนละเรื่องกับ LINE ส่วนตัวด้านบน — อันนี้คือการผูกบัญชีเข้ากับ OA ของหอ */}
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash px-3 py-2.5">
                  <div className="min-w-0">
                    <span className="block text-sm text-charcoal">
                      บัญชีที่รับแจ้งเตือนจากบอท
                    </span>
                    <span className="block text-xs text-fog">
                      แจ้งเตือนสลิปรอตรวจและสรุปผลการส่งบิลจะส่งมาที่บัญชีนี้ — ต้องเพิ่มเพื่อน OA ของหอก่อน
                    </span>
                    {ownerConnected && (
                      <span className="block text-xs text-steel">
                        {ownerNameWho}
                      </span>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Badge
                      tone={ownerConnected ? "paid" : "vacant"}
                      icon={ownerConnected ? "check_circle" : "link_off"}
                    >
                      {ownerConnected ? "เชื่อมแล้ว" : "ยังไม่เชื่อม"}
                    </Badge>
                    {ownerConnected && (
                      <Button
                        variant="danger-soft"
                        size="sm"
                        icon="link_off"
                        disabled={unlinking}
                        onClick={() => {
                          setConfirmUnlink(true);
                        }}
                      >
                        เลิกเชื่อม
                      </Button>
                    )}
                  </div>
                </div>

                {/*
                  บอกให้ชัดว่า OA ของหอคือตัวไหน — ก่อนหน้านี้สั่งให้ "เพิ่มเพื่อน OA
                  ของหอ" โดยไม่มีที่ไหนบอกชื่อ เจ้าของจึงทำตามไม่ได้ถ้าไม่ได้จำเอง
                  ค่ามาจาก LINE ตรง ๆ (settings.lineBot) จึงไม่ต้องมีใครกรอก
                */}
                {ownerBot !== null && ownerBot.basicId !== "" && (
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ash bg-paper-mist px-3 py-2.5">
                    <div className="min-w-0">
                      <span className="block text-xs text-fog">OA ของหอ</span>
                      <span className="block text-sm text-charcoal">
                        {ownerBot.displayName === "" ? ownerBot.basicId : `${ownerBot.displayName} · ${ownerBot.basicId}`}
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon="content_copy"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(ownerBot.basicId)
                          .then(() => {
                            setToast(`คัดลอก ${ownerBot.basicId} แล้ว`);
                          })
                          .catch(() => {
                            setToast("คัดลอกไม่สำเร็จ เลือกข้อความแล้วคัดลอกเองได้");
                          });
                      }}
                    >
                      คัดลอก
                    </Button>
                  </div>
                )}

                {!ownerConnected && (
                  <p className="mt-3 text-xs text-steel">
                    {ownerBot !== null && ownerBot.basicId !== ""
                      ? "วิธีเชื่อม: เพิ่มเพื่อน OA ข้างบน แล้วพิมพ์รหัสด้านล่างในแชทนั้น"
                      : "วิธีเชื่อม: เพิ่มเพื่อน OA ของหอ แล้วพิมพ์รหัสด้านล่างในแชทนั้น (ยังดึงชื่อ OA จาก LINE ไม่ได้ — เปิดใช้ LINE Messaging API ก่อน)"}
                  </p>
                )}

                <div className="mt-3 rounded-lg border border-ash p-4">
                  <p className="text-xs text-fog">รหัสเชื่อมต่อ 6 หลัก</p>
                  <p className="num mt-1 text-2xl tracking-[0.3em] text-charcoal">
                    {code}
                  </p>
                  <p className="mt-1 text-xs text-steel">
                    พิมพ์รหัสนี้ในแชท OA ของหอ (บอท) จากบัญชี LINE ของคุณ — รหัสใช้ได้ครั้งเดียวและหมดอายุใน 15 นาที
                  </p>
                  <Button
                    variant="secondary"
                    icon="refresh"
                    className="mt-3"
                    onClick={() => {
                      setConfirmRegen(true);
                    }}
                  >
                    ออกรหัสใหม่
                  </Button>
                </div>
              </Section>

              <Section
                id="settings-integrations"
                title="การเชื่อมต่อ"
                description="สถานะบริการที่หอใช้อยู่"
              >
                <ul className="grid gap-3">
                  <IntegrationRow
                    name="LINE Messaging API"
                    description="ใช้ส่งบิลและข้อความอัตโนมัติให้ผู้เช่า"
                    configured={settings.integrations.lineConfigured}
                  />
                  <IntegrationRow
                    name="SlipOK"
                    description="ตรวจสลิปอัตโนมัติเมื่อผู้เช่าส่งสลิปเข้ามา"
                    configured={settings.integrations.slipOkConfigured}
                  />
                </ul>

                {/*
                  ค่าเชื่อมต่อกรอกได้จากหน้านี้ (เก็บในตาราง settings ของหอนี้ และค่าที่
                  กรอกชนะ wrangler secret) — เดิมต้องรันคำสั่งบนเครื่องที่ deploy ได้
                  สถานะที่แสดงจึงบอกที่มาด้วยว่าใช้ค่าตัวไหนอยู่ ไม่งั้นเจ้าของจะแก้ค่าที่
                  ไม่มีผลแล้วไม่รู้ตัว · webhook ที่ LINE ตั้งไว้จริงเป็นอีกสาเหตุที่
                  "บอทเงียบ" แบบไร้ร่องรอย จึงยังเทียบปลายทางให้ดูและกดตั้งได้ในคลิกเดียว
                */}
                <div className="mt-4 rounded-lg border border-ash p-4">
                  <p className="text-xs font-medium text-charcoal">ช่อง LINE ที่ใช้อยู่</p>
                  {settings.integrations.lineConfigured ? (
                    <>
                      <dl className="mt-2 grid gap-2 text-xs">
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <dt className="text-fog">OA ที่ token ชี้อยู่</dt>
                          <dd className="text-charcoal">
                            {channel === null || channel.bot === null
                              ? "อ่านจาก LINE ไม่ได้"
                              : channel.bot.displayName === ""
                                ? channel.bot.basicId
                                : `${channel.bot.displayName} · ${channel.bot.basicId}`}
                          </dd>
                        </div>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <dt className="text-fog">Channel secret</dt>
                          <dd className="text-charcoal">
                            {channel === null
                              ? "—"
                              : channel.secretConfigured
                                ? "ตั้งไว้แล้ว"
                                : "ยังไม่ได้ตั้ง"}
                          </dd>
                        </div>
                        <div className="flex flex-wrap items-baseline justify-between gap-2">
                          <dt className="text-fog">Webhook ที่ LINE ตั้งไว้</dt>
                          <dd className="max-w-[60ch] break-all text-charcoal">
                            {channel === null || channel.webhook === null
                              ? "อ่านจาก LINE ไม่ได้"
                              : channel.webhook.endpoint === ""
                                ? "ยังไม่ได้ตั้ง"
                                : channel.webhook.endpoint}
                          </dd>
                        </div>
                      </dl>

                      {channel !== null && !channel.webhookPointsHere && (
                        <div className="mt-3 rounded-lg border border-ash bg-status-review-bg px-3 py-2.5">
                          <p className="text-xs text-status-review-fg">
                            webhook ยังไม่ชี้มาที่ระบบนี้ — ข้อความที่ผู้เช่าพิมพ์จะไม่ถึงบอท
                            (พิมพ์รหัสเชื่อมแล้วจะดูเหมือนไม่มีอะไรเกิดขึ้น)
                          </p>
                          <Button
                            variant="secondary"
                            size="sm"
                            icon="webhook"
                            className="mt-2"
                            disabled={settingWebhook}
                            onClick={() => {
                              void setWebhook();
                            }}
                          >
                            {settingWebhook ? "กำลังตั้ง" : "ตั้ง webhook ให้ระบบนี้"}
                          </Button>
                        </div>
                      )}
                    </>
                  ) : (
                    <p className="mt-2 text-xs text-steel">
                      ยังไม่ได้ตั้งค่า LINE — กรอก Channel access token กับ Channel secret
                      ด้านล่าง แล้วตั้ง webhook ให้ชี้มาที่
                      <code className="ml-1 rounded bg-paper-mist px-1 py-0.5">
                        {channel?.expectedWebhookEndpoint ?? "/webhook/line"}
                      </code>
                    </p>
                  )}

                  {isOwner ? (
                    <CredentialEditor
                      title="ตั้งค่า LINE OA ของหอ"
                      description="ค่าที่กรอกเก็บในฐานข้อมูลของหอนี้และใช้แทนค่าเดิมที่ตั้งไว้ตอน deploy — เว้นว่างไว้ = ไม่แก้"
                      fields={lineCredentialFields}
                      credentials={settings.credentials}
                      draft={credentialDraft}
                      onChange={changeCredential}
                      onClear={clearCredential}
                      onSave={() => {
                        saveCredentialFields(lineCredentialFields, "บันทึกค่า LINE แล้ว");
                      }}
                      saving={savingCredentials}
                      error={credentialError}
                    />
                  ) : (
                    <p className="mt-4 border-t border-ash pt-4 text-xs text-fog">
                      แก้ไขค่าเชื่อมต่อได้เฉพาะเจ้าของหอ — สมาชิกดูสถานะได้อย่างเดียว
                    </p>
                  )}

                  <p className="mt-3 text-xs text-fog">
                    เปลี่ยน OA: ผู้เช่าที่ผูกไว้จะใช้ต่อได้ถ้า OA ใหม่อยู่ใน LINE Provider เดิม
                    (userId ผูกกับ provider ไม่ใช่ช่อง) ถ้าย้าย provider ต้องให้ผู้เช่าพิมพ์เลขห้อง
                    + เบอร์ 4 ตัวท้ายใหม่
                    {channel !== null && channel.liffId !== "" && (
                      <> · LIFF ID ใช้กับฟอร์มลงทะเบียนผู้เช่า — แก้ให้ตรงกับ LIFF app ใหม่ด้วย</>
                    )}
                  </p>
                </div>

                <div className="mt-4 rounded-lg border border-ash p-4">
                  <p className="text-xs font-medium text-charcoal">SlipOK</p>
                  <p className="mt-1 text-xs text-fog">
                    ตรวจสลิปอัตโนมัติเมื่อผู้เช่าส่งรูปสลิปเข้ามา — API key กับ Branch ID
                    ดูได้จากหน้าเว็บของ SlipOK
                  </p>
                  {isOwner ? (
                    <CredentialEditor
                      title="ตั้งค่า SlipOK"
                      description="ค่าที่กรอกเก็บในฐานข้อมูลของหอนี้และใช้แทนค่าเดิมที่ตั้งไว้ตอน deploy — เว้นว่างไว้ = ไม่แก้"
                      fields={slipOkCredentialFields}
                      credentials={settings.credentials}
                      draft={credentialDraft}
                      onChange={changeCredential}
                      onClear={clearCredential}
                      onSave={() => {
                        saveCredentialFields(slipOkCredentialFields, "บันทึกค่า SlipOK แล้ว");
                      }}
                      saving={savingCredentials}
                      error={credentialError}
                    />
                  ) : (
                    <p className="mt-3 text-xs text-fog">แก้ไขได้เฉพาะเจ้าของหอ</p>
                  )}
                </div>
              </Section>
            </>
          )}
        </div>
      </div>

      {ready && (
        <div className="save-bar fixed inset-x-0 bottom-[calc(3.5rem_+_env(safe-area-inset-bottom))] z-30 border-t border-ash bg-canvas-white px-4 py-3 md:inset-x-auto md:bottom-6 md:right-6 md:rounded-xl md:border md:px-3 md:py-2">
          <Button
            variant="primary"
            icon="save"
            className="w-full md:w-auto"
            disabled={!canSave}
            onClick={() => {
              if (payChanged) {
                setConfirmPayChange(true);
              } else {
                void save();
              }
            }}
          >
            บันทึกการตั้งค่า
          </Button>
        </div>
      )}

      <Dialog
        open={confirmRegen}
        onClose={() => {
          if (!regenerating) {
            setConfirmRegen(false);
          }
        }}
        title="ออกรหัสเชื่อมต่อใหม่"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={regenerating}
              onClick={() => {
                setConfirmRegen(false);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon="refresh"
              disabled={regenerating}
              onClick={() => {
                void regenCode();
              }}
            >
              {regenerating ? "กำลังออกรหัส" : "ออกรหัสใหม่"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-steel">
          เมื่อยืนยันแล้ว รหัสเดิม {code} จะถูกยกเลิกทันที
          และใช้เชื่อมต่อไม่ได้อีก ต้องใช้รหัสใหม่เท่านั้น
        </p>
      </Dialog>

      <Dialog
        open={confirmUnlink}
        onClose={() => {
          setConfirmUnlink(false);
        }}
        title="ยืนยันเลิกเชื่อม LINE"
        footer={
          <>
            <Button
              variant="ghost"
              disabled={unlinking}
              onClick={() => {
                setConfirmUnlink(false);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon="link_off"
              disabled={unlinking}
              onClick={() => {
                void unlink();
              }}
            >
              {unlinking ? "กำลังเลิกเชื่อม" : "เลิกเชื่อม"}
            </Button>
          </>
        }
      >
        <p className="text-sm text-steel">
          หลังเลิกเชื่อม ระบบจะไม่ส่งแจ้งเตือนสลิปรอตรวจหรือสรุปการส่งบิลไปที่ LINE อีก
          และรหัสเชื่อมต่อเดิมจะถูกยกเลิก — ถ้าต้องการเชื่อมใหม่
          ให้เพิ่มเพื่อน OA แล้วใช้รหัสใหม่ที่หน้าตั้งค่าจะแสดงให้อีกครั้ง
        </p>
      </Dialog>

      <Dialog
        open={confirmPayChange}
        onClose={() => {
          setConfirmPayChange(false);
        }}
        title="ยืนยันเปลี่ยนช่องทางรับเงิน"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setConfirmPayChange(false);
              }}
            >
              ยกเลิก
            </Button>
            <Button
              variant="primary"
              icon="save"
              onClick={() => {
                setConfirmPayChange(false);
                void save();
              }}
            >
              ยืนยันและบันทึก
            </Button>
          </>
        }
      >
        <div className="grid gap-3">
          <p className="text-sm text-steel">
            ช่องทางรับเงินเป็นปลายทางที่เงินของผู้เช่าจะเข้า
            จึงต้องยืนยันก่อนบันทึก
          </p>
          <dl className="grid gap-2 rounded-lg border border-ash p-3 text-sm">
            {payChanges.map((change) => (
              <div
                key={change.label}
                className="flex flex-wrap items-start justify-between gap-3"
              >
                <dt className="text-steel">{change.label}</dt>
                <dd className="num text-charcoal">
                  {change.from} → {change.to}
                </dd>
              </div>
            ))}
          </dl>
          <div className="panel-muted">
            <p className="text-sm text-charcoal">
              บิลที่ออกใหม่หลังจากนี้จะสร้าง QR จากพร้อมเพย์ใหม่
            </p>
            <p className="mt-1 text-xs text-steel">
              บิลที่สร้างไปแล้วยังเก็บพร้อมเพย์และอัตราน้ำ/ค่าไฟที่ใช้ตอนออกบิลไว้ในตัวบิลนั้น
              ไม่เปลี่ยนตาม
            </p>
          </div>
        </div>
      </Dialog>

      <Toast message={toast ?? ""} open={toast !== null} />
    </div>
  );
}
